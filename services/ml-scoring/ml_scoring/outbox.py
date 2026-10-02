"""At-least-once publisher for the isolated shadow-prediction outbox."""

from __future__ import annotations

import json
import math
import threading
from typing import Any

from confluent_kafka import Producer

from ml_scoring.events import SHADOW_PREDICTION_TOPIC
from ml_scoring.store import Repository

DELIVERY_TIMEOUT_SECONDS = 10.0
DB_OPERATION_TIMEOUT_SECONDS = 15


class FatalKafkaProducerError(RuntimeError):
    """The Kafka producer is unusable; retrying with this instance is unsafe."""


def _fatal_kafka_error(error: object) -> bool:
    fatal = getattr(error, "fatal", None)
    try:
        return bool(fatal()) if callable(fatal) else False
    except Exception:
        return False


def publish_pending_once(repository: Repository, producer: Producer, tenant_id: str, *,
                         batch_size: int = 1, lease_seconds: int = 30,
                         delivery_timeout_seconds: float = DELIVERY_TIMEOUT_SECONDS,
                         stop: threading.Event | None = None) -> int:
    """Publish a bounded leased batch; duplicates are safe by stable event ID.

    The DB claim commits before network I/O. Kafka acknowledgement precedes the
    DB published mark, so a crash in between can duplicate but never lose output.
    """
    if not 1 <= batch_size <= 100 or not math.isfinite(delivery_timeout_seconds) \
            or delivery_timeout_seconds <= 0:
        raise ValueError("shadow outbox batch and delivery timeout bounds are invalid")
    # Each row can spend the full delivery timeout in Kafka flush plus the shared
    # bounded DB operation window for its DB mark. Keep another
    # five seconds for transaction/claim overhead so a live batch is not reclaimed.
    minimum_lease = math.ceil(
        batch_size * (delivery_timeout_seconds + DB_OPERATION_TIMEOUT_SECONDS) + 5
    )
    if lease_seconds < minimum_lease:
        raise ValueError(
            f"shadow outbox lease ({lease_seconds}s) is shorter than batch bound ({minimum_lease}s)"
        )
    with repository.tenant_transaction(tenant_id) as transaction:
        lease_token, pending = transaction.claim_pending_shadow_events(batch_size, lease_seconds)
    published = 0
    for index, item in enumerate(pending):
        event_id = item["event_id"]
        if stop is not None and stop.is_set():
            with repository.tenant_transaction(tenant_id) as transaction:
                for unprocessed in pending[index:]:
                    transaction.release_shadow_event(
                        unprocessed["event_id"], lease_token, "relay_stopping",
                    )
            break
        payload = json.dumps(item["payload"], sort_keys=True, separators=(",", ":"), allow_nan=False)
        delivery_errors: list[object | None] = []
        try:
            try:
                producer.produce(
                    SHADOW_PREDICTION_TOPIC,
                    key=f"{tenant_id}:{event_id}",
                    value=payload,
                    on_delivery=lambda error, _message: delivery_errors.append(error),
                )
            except Exception as exc:
                kafka_error = (exc.args[0] if exc.args and callable(getattr(exc.args[0], "fatal", None))
                               else exc)
                if _fatal_kafka_error(kafka_error):
                    raise FatalKafkaProducerError("Kafka producer entered a fatal state") from exc
                raise
            remaining = producer.flush(delivery_timeout_seconds)
            delivery_error = delivery_errors[-1] if delivery_errors else None
            if _fatal_kafka_error(delivery_error):
                raise FatalKafkaProducerError("Kafka delivery reported a fatal producer error")
            if remaining or not delivery_errors or delivery_error is not None:
                reason = (str(delivery_error) if delivery_error is not None else
                          f"Kafka delivery timed out with {remaining} queued records")
                raise RuntimeError(f"shadow Kafka delivery failed: {reason or 'unknown Kafka error'}")
            with repository.tenant_transaction(tenant_id) as transaction:
                if not transaction.mark_shadow_event_published(event_id, lease_token):
                    raise RuntimeError("shadow outbox lease was lost after Kafka acknowledgement")
            published += 1
        except Exception as exc:
            with repository.tenant_transaction(tenant_id) as transaction:
                reason = f"{type(exc).__name__}: {exc}"
                for unprocessed in pending[index:]:
                    transaction.release_shadow_event(unprocessed["event_id"], lease_token, reason)
            raise
    return published
