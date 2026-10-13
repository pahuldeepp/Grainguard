"""Transactional-outbox Kafka relay and idempotent document index consumer."""

from __future__ import annotations
from .prompt_guardrails import PromptInjectionError

import json
import threading
from datetime import datetime, timezone, date
from typing import Any, Callable
from uuid import UUID
from .pdf_parser import PdfParseError

TOPIC = "greenguard.knowledge.document.index.requested.v1"
SUGGESTION_USAGE_TOPIC = "greenguard.knowledge.assistant.suggestion.used.v1"
SUGGESTION_IDS = frozenset({"grain_moisture", "storage_checks", "mold_risk", "grain_drying", "document_summary"})


class InvalidSuggestionUsageEvent(ValueError):
    """A syntactically valid Kafka record is not backed by its tenant outbox row."""


def _uuid(value: Any) -> bool:
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def publish_pending_once(connect: Callable[[], Any], producer: Any, tenant_id: str,
                         *, limit: int = 25, lease_seconds: int = 300) -> int:
    """Claim rows with SKIP LOCKED, publish stable ID-only events, then mark sent.

    Kafka acknowledgement precedes the DB mark. A crash between them produces
    a duplicate, so consumers must remain idempotent.
    """
    if not 1 <= limit <= 100 or lease_seconds < limit * 10 + 15:
        raise ValueError("outbox relay bounds are invalid")
    with connect() as conn:
        with conn.transaction():
            conn.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
            rows = conn.execute(
                """WITH candidates AS (
                       SELECT event_id FROM knowledge_index_outbox
                       WHERE tenant_id=%s AND published_at IS NULL AND processed_at IS NULL
                         AND available_at<=clock_timestamp()
                         AND (claimed_until IS NULL OR claimed_until<=clock_timestamp())
                       ORDER BY created_at,event_id FOR UPDATE SKIP LOCKED LIMIT %s
                   )
                   UPDATE knowledge_index_outbox o
                   SET claim_token=gen_random_uuid(),claimed_until=clock_timestamp()+(%s * interval '1 second')
                   FROM candidates c WHERE o.tenant_id=%s AND o.event_id=c.event_id
                   RETURNING o.event_id::text,o.document_id::text,o.document_version,o.claim_token::text""",
                (tenant_id, limit, lease_seconds, tenant_id),
            ).fetchall()
    count = 0
    for ordinal, (event_id, doc_id, version, claim) in enumerate(rows):
        payload = json.dumps({"schema_version": 1, "event_id": str(event_id),
                              "tenant_id": tenant_id, "document_id": str(doc_id),
                              "document_version": int(version)}, separators=(",", ":"))
        delivery: list[str | None] = []
        try:
            producer.produce(TOPIC, key=f"{tenant_id}:{doc_id}", value=payload,
                             on_delivery=lambda error, _msg: delivery.append(str(error) if error else None))
            remaining = producer.flush(10)
            if remaining or not delivery or delivery[-1] is not None:
                raise RuntimeError("Kafka delivery failed")
        except Exception:
            # Release only our fenced failed/unattempted claims. An ambiguous
            # broker acknowledgement may duplicate on retry; consumers are idempotent.
            try:
                with connect() as conn, conn.transaction():
                    conn.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                    for failed_id, _doc, _version, failed_claim in rows[ordinal:]:
                        conn.execute(
                            "UPDATE knowledge_index_outbox SET claim_token=NULL,claimed_until=NULL "
                            "WHERE tenant_id=%s AND event_id=%s AND claim_token=%s AND processed_at IS NULL",
                            (tenant_id, failed_id, failed_claim),
                        )
            except Exception:
                pass  # DB outage leaves the bounded lease to expire; never mask original failure.
            raise
        with connect() as conn:
            with conn.transaction():
                conn.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                result = conn.execute(
                    """UPDATE knowledge_index_outbox SET published_at=clock_timestamp(),
                       claim_token=NULL,claimed_until=NULL
                       WHERE tenant_id=%s AND event_id=%s AND claim_token=%s""",
                    (tenant_id, event_id, claim),
                )
                if result.rowcount != 1:
                    completed = conn.execute(
                        "SELECT processed_at FROM knowledge_index_outbox WHERE tenant_id=%s AND event_id=%s",
                        (tenant_id, event_id),
                    ).fetchone()
                    if completed is None or completed[0] is None:
                        raise RuntimeError("outbox relay lease expired before acknowledgement mark")
        count += 1
    return count


def publish_suggestion_usage_once(connect: Callable[[], Any], producer: Any, tenant_id: str,
                                  *, limit: int = 25, lease_seconds: int = 300) -> int:
    """Claim and publish suggestion-use outbox rows, then mark Kafka ack in PG.

    Kafka delivery can be repeated after a crash between broker acknowledgement
    and the Postgres mark. The stable tenant/event key and consumer ledger make
    that at-least-once publication safe.
    """
    if not 1 <= limit <= 100 or lease_seconds < limit * 10 + 15:
        raise ValueError("outbox relay bounds are invalid")
    with connect() as conn:
        with conn.transaction():
            conn.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
            rows = conn.execute(
                """WITH candidates AS (
                       SELECT event_id FROM assistant_suggestion_usage_outbox
                       WHERE tenant_id=%s AND published_at IS NULL
                         AND (claimed_until IS NULL OR claimed_until<=clock_timestamp())
                       ORDER BY created_at,event_id FOR UPDATE SKIP LOCKED LIMIT %s
                   )
                   UPDATE assistant_suggestion_usage_outbox o
                   SET claim_token=gen_random_uuid(),claimed_until=clock_timestamp()+(%s * interval '1 second')
                   FROM candidates c WHERE o.tenant_id=%s AND o.event_id=c.event_id
                   RETURNING o.event_id::text,o.suggestion_id,o.created_at,o.claim_token::text""",
                (tenant_id, limit, lease_seconds, tenant_id),
            ).fetchall()
    count = 0
    for ordinal, (event_id, suggestion_id, created_at, claim) in enumerate(rows):
        event = {"schema_version": 1, "event_id": str(event_id), "tenant_id": tenant_id,
                 "suggestion_id": suggestion_id, "created_at": _timestamp_utc(created_at)}
        payload = json.dumps(event, separators=(",", ":"))
        delivery: list[str | None] = []
        try:
            producer.produce(SUGGESTION_USAGE_TOPIC, key=f"{tenant_id}:{event_id}", value=payload,
                             on_delivery=lambda error, _msg: delivery.append(str(error) if error else None))
            remaining = producer.flush(10)
        except Exception:
            remaining = 1
        if remaining or not delivery or delivery[-1] is not None:
            try:
                with connect() as conn, conn.transaction():
                    conn.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                    for failed_id, _suggestion, _created, failed_claim in rows[ordinal:]:
                        conn.execute(
                            "UPDATE assistant_suggestion_usage_outbox SET claim_token=NULL,claimed_until=NULL "
                            "WHERE tenant_id=%s AND event_id=%s AND claim_token=%s AND published_at IS NULL",
                            (tenant_id, failed_id, failed_claim),
                        )
            except Exception:
                pass  # Bounded leases expire if the DB is unavailable; keep the delivery failure.
            raise RuntimeError(f"Kafka delivery failed: {delivery[-1] if delivery else 'timeout'}")
        with connect() as conn:
            with conn.transaction():
                conn.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                result = conn.execute(
                    """UPDATE assistant_suggestion_usage_outbox
                          SET published_at=clock_timestamp(),claim_token=NULL,claimed_until=NULL
                        WHERE tenant_id=%s AND event_id=%s AND claim_token=%s""",
                    (tenant_id, event_id, claim),
                )
                if result.rowcount != 1:
                    published = conn.execute(
                        "SELECT published_at FROM assistant_suggestion_usage_outbox WHERE tenant_id=%s AND event_id=%s",
                        (tenant_id, event_id),
                    ).fetchone()
                    if published is None or published[0] is None:
                        raise RuntimeError("suggestion outbox lease expired before acknowledgement mark")
        count += 1
    return count


def _timestamp_utc(value: Any) -> str:
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    elif isinstance(value, datetime):
        parsed = value
    else:
        raise ValueError("suggestion usage created_at is invalid")
    if parsed.tzinfo is None:
        raise ValueError("suggestion usage created_at must be timezone-aware")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def decode_suggestion_usage_event(message: Any) -> dict[str, Any]:
    try:
        value = json.loads(message.value())
        if (not isinstance(value, dict) or set(value) != {
            "schema_version", "event_id", "tenant_id", "suggestion_id", "created_at"
        } or type(value["schema_version"]) is not int or value["schema_version"] != 1
                or not _uuid(value["event_id"]) or not _uuid(value["tenant_id"])
                or value["suggestion_id"] not in SUGGESTION_IDS
                or not isinstance(value["created_at"], str)):
            raise ValueError
        timestamp = datetime.fromisoformat(value["created_at"].replace("Z", "+00:00"))
        if timestamp.tzinfo is None or timestamp.utcoffset() != timezone.utc.utcoffset(timestamp):
            raise ValueError
        value["created_at"] = timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        if message.key().decode() != f"{value['tenant_id']}:{value['event_id']}":
            raise ValueError
        return value
    except (ValueError, TypeError, AttributeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid assistant suggestion usage Kafka event") from exc


def apply_suggestion_usage_event(connect: Callable[[], Any], event: dict[str, Any]) -> bool:
    """Deduplicate and aggregate one usage event atomically; False means duplicate."""
    usage_date = date.fromisoformat(event["created_at"][:10])
    with connect() as conn:
        with conn.transaction():
            conn.execute("SELECT set_config('app.tenant_id', %s, true)", (event["tenant_id"],))
            inserted = conn.execute(
                """INSERT INTO assistant_suggestion_usage_events
                       (tenant_id,event_id,suggestion_id,created_at)
                   VALUES (%s,%s,%s,%s::timestamptz)
                   ON CONFLICT (tenant_id,event_id) DO NOTHING
                   RETURNING event_id""",
                (event["tenant_id"], event["event_id"], event["suggestion_id"], event["created_at"]),
            ).fetchone()
            if inserted is None:
                return False
            source = conn.execute(
                """SELECT suggestion_id,created_at FROM assistant_suggestion_usage_outbox
                    WHERE tenant_id=%s AND event_id=%s""",
                (event["tenant_id"], event["event_id"]),
            ).fetchone()
            if (source is None or source[0] != event["suggestion_id"]
                    or _timestamp_utc(source[1]) != event["created_at"]):
                raise InvalidSuggestionUsageEvent("suggestion event does not match its tenant outbox record")
            conn.execute(
                """INSERT INTO assistant_suggestion_usage_daily
                       (tenant_id,usage_date,suggestion_id,usage_count,last_used_at)
                   VALUES (%s,%s,%s,1,%s::timestamptz)
                   ON CONFLICT (tenant_id,usage_date,suggestion_id) DO UPDATE
                     SET usage_count=assistant_suggestion_usage_daily.usage_count+1,
                         last_used_at=GREATEST(assistant_suggestion_usage_daily.last_used_at,EXCLUDED.last_used_at),
                         updated_at=clock_timestamp()""",
                (event["tenant_id"], usage_date, event["suggestion_id"], event["created_at"]),
            )
    return True


def consume_suggestion_analytics_forever(consumer: Any, connect: Callable[[], Any], *, stop: threading.Event,
                                         quarantine_producer: Any | None = None) -> None:
    """Commit offsets only after aggregate commit or durable malformed-event quarantine."""
    delay = 1
    while not stop.is_set():
        message = consumer.poll(0.5)
        if message is None:
            continue
        error = message.error()
        if error:
            if error.fatal():
                raise RuntimeError("fatal Kafka consumer error")
            continue
        try:
            event = decode_suggestion_usage_event(message)
        except ValueError:
            _quarantine_suggestion_usage(consumer, quarantine_producer, message)
            continue
        while not stop.is_set():
            try:
                apply_suggestion_usage_event(connect, event)
                consumer.commit(message=message, asynchronous=False)
                delay = 1
                break
            except InvalidSuggestionUsageEvent:
                _quarantine_suggestion_usage(consumer, quarantine_producer, message)
                break
            except Exception:
                if stop.wait(delay):
                    return
                delay = min(delay * 2, 60)


def _quarantine_suggestion_usage(consumer: Any, producer: Any | None, message: Any) -> None:
    if producer is None:
        raise RuntimeError("malformed suggestion event requires quarantine producer")
    receipt = json.dumps({"topic": message.topic(), "partition": message.partition(),
                          "offset": message.offset(), "reason": "invalid_event"})
    delivered: list[bool] = []
    producer.produce(SUGGESTION_USAGE_TOPIC + ".quarantine", value=receipt,
        on_delivery=lambda delivery_error, _msg: delivered.append(delivery_error is None))
    if producer.flush(10) or not delivered or not delivered[-1]:
        raise RuntimeError("suggestion quarantine delivery failed")
    consumer.commit(message=message, asynchronous=False)


def decode_event(message: Any) -> dict[str, Any]:
    try:
        value = json.loads(message.value())
        if (not isinstance(value, dict) or set(value) != {
            "schema_version", "event_id", "tenant_id", "document_id", "document_version"
        } or type(value["schema_version"]) is not int or value["schema_version"] != 1
                or not all(_uuid(value[field]) for field in ("event_id", "tenant_id", "document_id"))
                or type(value["document_version"]) is not int or not 1 <= value["document_version"] <= 2**63-1
                or message.key().decode() != f"{value['tenant_id']}:{value['document_id']} ".strip()):
            raise ValueError
        return value
    except (ValueError, TypeError, AttributeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid knowledge index Kafka event") from exc


def consume_forever(consumer: Any, service: Any, *, stop: threading.Event,
                    quarantine_producer: Any | None = None) -> None:
    """Commit Kafka offsets only after parsing, Postgres, embeddings and vector upsert."""
    while not stop.is_set():
        message = consumer.poll(0.5)
        if message is None:
            continue
        error = message.error()
        if error:
            if error.fatal():
                raise RuntimeError("fatal Kafka consumer error")
            continue
        try:
            event = decode_event(message)
        except ValueError:
            if quarantine_producer is None:
                raise RuntimeError('malformed event requires a durable quarantine producer')
            # Store only broker coordinates, never untrusted source content.
            receipt = json.dumps({'topic': message.topic(), 'partition': message.partition(),
                                  'offset': message.offset(), 'reason': 'invalid_event'})
            delivered: list[bool] = []
            quarantine_producer.produce(TOPIC + '.quarantine', value=receipt,
                                        on_delivery=lambda error, _msg: delivered.append(error is None))
            if quarantine_producer.flush(10) or not delivered or not delivered[-1]:
                raise RuntimeError('quarantine delivery failed')
            consumer.commit(message=message, asynchronous=False)
            continue
        delay = 15
        while not stop.is_set():
            try:
                service.process_document_event(
                    tenant_id=event['tenant_id'], document_id=event['document_id'],
                    document_version=event['document_version'], event_id=event['event_id'],
                )
                break
            except Exception as exc:
                try:
                    recorded = service.record_index_failure(
                        event=event, permanent=isinstance(exc, (PdfParseError, PromptInjectionError)))
                except Exception:
                    # A recorder/DB outage is retryable. Do not acknowledge the
                    # Kafka record until work, a retry schedule, or permanent failure is durable.
                    recorded = False
                if recorded:
                    break
                if stop.wait(delay):
                    return
                delay = min(delay * 2, 120)
        if stop.is_set():
            return
        consumer.commit(message=message, asynchronous=False)
