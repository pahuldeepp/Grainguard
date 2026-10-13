"""Tenant-scoped prediction repository with forced-RLS PostgreSQL adapter."""

from __future__ import annotations

from contextlib import contextmanager
import copy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import math
import threading
import struct
from typing import Any, Iterator, Protocol
import uuid

from ml_scoring.contracts import TelemetryEvent


class DuplicateEventConflict(RuntimeError):
    """A previously seen event identity was replayed with different content."""


INBOX_PRUNE_BATCH_SIZE = 1_000
SHADOW_RETENTION_BATCH_SIZE = 1_000
MAX_DRIFT_SAMPLE_COUNT = 100_000
DRIFT_FEATURES = frozenset({"temperature_c", "relative_humidity_percent"})
DRIFT_WINDOW_RETENTION = timedelta(days=90)
DRIFT_RETENTION_BATCH_SIZE = 100
MAX_DRIFT_WINDOW_BYTES = 200_000


def _validate_drift_status(model_name: str, model_version: str, feature_name: str,
                           psi: float | None, sample_count: int,
                           window_state: dict[str, object] | None = None) -> None:
    if (feature_name not in DRIFT_FEATURES
            or not isinstance(model_name, str) or not 1 <= len(model_name) <= 128
            or not isinstance(model_version, str) or not 1 <= len(model_version) <= 128
            or (psi is not None and (isinstance(psi, bool)
                                     or not isinstance(psi, (int, float))
                                     or not math.isfinite(psi) or psi < 0))
            or type(sample_count) is not int
            or not 0 <= sample_count <= MAX_DRIFT_SAMPLE_COUNT
            or (psi is None and window_state is None)
            or (window_state is None and sample_count == 0)):
        raise ValueError("drift status is outside the supported aggregate contract")
    _validate_drift_window_state(window_state)
    if window_state is not None and (
            sample_count != len(window_state["bins"])
            or psi != window_state["current_psi"]):
        raise ValueError("drift snapshot must match its persisted PSI window")


def _validate_drift_window_state(state: dict[str, object] | None) -> None:
    if state is None:  # Legacy PSI-only status remains readable during migration.
        return
    required = {"version", "window_size", "bins", "counts", "seen_count",
                "last_update_count", "current_psi"}
    if not isinstance(state, dict) or set(state) != required:
        raise ValueError("drift window state has an invalid shape")
    window_size, bins, counts = state["window_size"], state["bins"], state["counts"]
    if (state["version"] != 1 or type(window_size) is not int
            or not 1 <= window_size <= MAX_DRIFT_SAMPLE_COUNT
            or not isinstance(bins, (list, tuple)) or len(bins) > window_size
            or len(bins) * 2 > MAX_DRIFT_WINDOW_BYTES
            or not isinstance(counts, (list, tuple)) or not 3 <= len(counts) <= 1025
            or any(type(item) is not int or not 0 <= item < len(counts) for item in bins)
            or any(type(item) is not int or item < 0 for item in counts)
            or sum(counts) != len(bins)
            or type(state["seen_count"]) is not int or state["seen_count"] < len(bins)
            or type(state["last_update_count"]) is not int
            or not 0 <= state["last_update_count"] <= state["seen_count"]
            or (state["current_psi"] is not None
                and (isinstance(state["current_psi"], bool)
                     or not isinstance(state["current_psi"], (int, float))
                     or not math.isfinite(state["current_psi"])
                     or state["current_psi"] < 0))):
        raise ValueError("drift window state is outside the bounded aggregate contract")


def _encode_drift_bins(bins: tuple[int, ...] | list[int]) -> bytes:
    return b"".join(struct.pack("!H", value) for value in bins)


def _decode_drift_bins(raw: bytes) -> tuple[int, ...]:
    if not isinstance(raw, bytes) or len(raw) > MAX_DRIFT_WINDOW_BYTES or len(raw) % 2:
        raise ValueError("persisted drift window bytes are malformed or oversized")
    return tuple(value[0] for value in struct.iter_unpack("!H", raw))


@dataclass(frozen=True)
class ShadowPrediction:
    prediction_id: str
    tenant_id: str
    subject_id: str
    window_end: str
    model_name: str
    model_version: str
    feature_set_version: str
    revision: int
    probability: float
    feature_digest: str
    correlation_id: str
    causation_id: str
    traceparent: str
    status: str = "shadow"
    data_origin: str = "synthetic_grain_sim"


class Transaction(Protocol):
    def prune_inbox(self, before: datetime) -> int: ...
    def prune_published_shadow_rows(self, before: datetime) -> int: ...
    def load_drift_status(self, model_name: str, model_version: str) -> dict[str, tuple[float, int]]: ...
    def upsert_drift_status(self, model_name: str, model_version: str, feature_name: str,
                            psi: float | None, sample_count: int,
                            window_state: dict[str, object] | None = None) -> None: ...
    def load_drift_window(self, model_name: str, model_version: str,
                          feature_name: str) -> dict[str, object] | None: ...
    def prune_drift_status(self, before: datetime) -> int: ...
    def claim_event(self, event: TelemetryEvent, *, topic: str, partition: int, offset: int) -> bool: ...
    def load_bin_state(self, bin_id: str) -> dict[str, Any]: ...
    def save_bin_state(self, bin_id: str, state: dict[str, Any], source_sequence: int) -> None: ...
    def write_shadow_prediction(self, prediction: ShadowPrediction,
                                event: dict[str, object]) -> bool: ...
    def claim_pending_shadow_events(self, limit: int, lease_seconds: int) -> tuple[str, list[dict[str, Any]]]: ...
    def mark_shadow_event_published(self, event_id: str, lease_token: str) -> bool: ...
    def release_shadow_event(self, event_id: str, lease_token: str, error: str) -> bool: ...


class Repository(Protocol):
    def tenant_transaction(self, tenant_id: str) -> Any: ...
    def quarantine(self, *, topic: str, partition: int, offset: int, reason: str, digest: str) -> None: ...
    def ping(self) -> bool: ...


class InMemoryRepository:
    """Deterministic transaction fake for isolated local acceptance tests."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._events: dict[tuple[str, str], str] = {}
        self._states: dict[tuple[str, str], dict[str, Any]] = {}
        self._predictions: dict[tuple[str, str], ShadowPrediction] = {}
        self._shadow_outbox: dict[tuple[str, str], dict[str, object]] = {}
        self.quarantined: list[dict[str, Any]] = []
        self.inbox_prune_calls: list[datetime] = []
        self.inbox_prune_rows = 0
        self.shadow_prune_calls: list[datetime] = []
        self.shadow_prune_rows = 0
        self._drift_status: dict[tuple[str, str, str, str], tuple[float, int]] = {}

    @contextmanager
    def tenant_transaction(self, tenant_id: str) -> Iterator["_MemoryTransaction"]:
        with self._lock:
            snapshot = (self._events.copy(), copy.deepcopy(self._states),
                        self._predictions.copy(), copy.deepcopy(self._shadow_outbox),
                        self._drift_status.copy())
            try:
                yield _MemoryTransaction(self, tenant_id)
            except BaseException:
                (self._events, self._states, self._predictions,
                 self._shadow_outbox, self._drift_status) = snapshot
                raise

    def quarantine(self, *, topic: str, partition: int, offset: int, reason: str, digest: str) -> None:
        with self._lock:
            self.quarantined.append({"topic": topic, "partition": partition,
                                     "offset": offset, "reason": reason, "digest": digest})
            del self.quarantined[:-1000]

    def ping(self) -> bool:
        return True

    @property
    def predictions(self) -> list[ShadowPrediction]:
        with self._lock:
            return list(self._predictions.values())


class _MemoryTransaction:
    def __init__(self, repository: InMemoryRepository, tenant_id: str):
        self.repository, self.tenant_id = repository, tenant_id

    def prune_inbox(self, before: datetime) -> int:
        self.repository.inbox_prune_calls.append(before)
        return self.repository.inbox_prune_rows

    def prune_published_shadow_rows(self, before: datetime) -> int:
        self.repository.shadow_prune_calls.append(before)
        return self.repository.shadow_prune_rows

    def load_drift_status(self, model_name: str, model_version: str) -> dict[str, tuple[float, int]]:
        return {feature: (float(value[0]), int(value[1]))
                for (tenant, name, version, feature), value
                in self.repository._drift_status.items()
                if tenant == self.tenant_id and name == model_name and version == model_version
                and value[0] is not None}

    def load_drift_window(self, model_name: str, model_version: str,
                          feature_name: str) -> dict[str, object] | None:
        status = self.repository._drift_status.get(
            (self.tenant_id, model_name, model_version, feature_name),
        )
        return copy.deepcopy(status[2]) if status is not None and len(status) > 2 else None

    def prune_drift_status(self, before: datetime) -> int:
        doomed = [key for key, value in self.repository._drift_status.items()
                  if key[0] == self.tenant_id and len(value) > 3 and value[3] < before]
        doomed = doomed[:DRIFT_RETENTION_BATCH_SIZE]
        for key in doomed:
            del self.repository._drift_status[key]
        return len(doomed)

    def upsert_drift_status(self, model_name: str, model_version: str, feature_name: str,
                            psi: float | None, sample_count: int,
                            window_state: dict[str, object] | None = None) -> None:
        _validate_drift_status(model_name, model_version, feature_name, psi, sample_count, window_state)
        self.repository._drift_status[(self.tenant_id, model_name, model_version, feature_name)] = (
            None if psi is None else float(psi), int(sample_count),
            copy.deepcopy(window_state), datetime.now(timezone.utc),
        )

    def claim_event(self, event: TelemetryEvent, *, topic: str, partition: int, offset: int) -> bool:
        del topic, partition, offset
        key = (self.tenant_id, event.event_id)
        prior = self.repository._events.get(key)
        if prior is not None:
            if prior != event.digest:
                raise DuplicateEventConflict("event ID replayed with a different content digest")
            return False
        self.repository._events[key] = event.digest
        return True

    def load_bin_state(self, bin_id: str) -> dict[str, Any]:
        return json.loads(json.dumps(
            self.repository._states.get((self.tenant_id, bin_id), {"devices": {}})
        ))

    def save_bin_state(self, bin_id: str, state: dict[str, Any], source_sequence: int) -> None:
        del source_sequence
        self.repository._states[(self.tenant_id, bin_id)] = json.loads(json.dumps(state))

    def write_shadow_prediction(self, prediction: ShadowPrediction,
                                event: dict[str, object]) -> bool:
        key = (prediction.tenant_id, prediction.prediction_id)
        if key in self.repository._predictions:
            return False
        self.repository._predictions[key] = prediction
        outbox_key = (prediction.tenant_id, str(event["event_id"]))
        if outbox_key in self.repository._shadow_outbox:
            raise ValueError("shadow outbox event identity already exists")
        self.repository._shadow_outbox[outbox_key] = {
            "payload": copy.deepcopy(event), "published_at": None,
            "lease_token": None, "lease_until": None, "attempt_count": 0,
        }
        return True

    def claim_pending_shadow_events(self, limit: int, lease_seconds: int) -> tuple[str, list[dict[str, Any]]]:
        if not 1 <= limit <= 100 or lease_seconds < 1:
            raise ValueError("shadow outbox claim bounds are invalid")
        now, token = datetime.now(timezone.utc), str(uuid.uuid4())
        claimed = []
        for (tenant, event_id), row in sorted(self.repository._shadow_outbox.items()):
            lease_until = row["lease_until"]
            if tenant != self.tenant_id or row["published_at"] is not None or (lease_until and lease_until > now):
                continue
            row["lease_token"], row["lease_until"] = token, now + timedelta(seconds=lease_seconds)
            row["attempt_count"] += 1
            claimed.append({"event_id": event_id, "payload": copy.deepcopy(row["payload"])})
            if len(claimed) == limit:
                break
        return token, claimed

    def mark_shadow_event_published(self, event_id: str, lease_token: str) -> bool:
        row = self.repository._shadow_outbox.get((self.tenant_id, event_id))
        if row is None or row["lease_token"] != lease_token or row["published_at"] is not None:
            return False
        row["published_at"] = datetime.now(timezone.utc)
        row["lease_token"], row["lease_until"] = None, None
        return True

    def release_shadow_event(self, event_id: str, lease_token: str, error: str) -> bool:
        row = self.repository._shadow_outbox.get((self.tenant_id, event_id))
        if row is None or row["lease_token"] != lease_token:
            return False
        row["last_error"] = error[:500]
        row["lease_token"], row["lease_until"] = None, None
        return True


class PostgresRepository:
    """Tenant-scoped repository backed by a small bounded PostgreSQL pool."""

    def __init__(self, database_url: str, connection_factory: Any | None = None,
                 *, pool_max_size: int = 4):
        if not database_url.startswith(("postgresql://", "postgres://")):
            raise ValueError("ML_DATABASE_URL must use PostgreSQL")
        if pool_max_size < 1 or pool_max_size > 16:
            raise ValueError("pool_max_size must be from 1 through 16")
        self.database_url = database_url
        self.connection_factory = connection_factory
        self._pool = None
        if connection_factory is None:
            from psycopg_pool import ConnectionPool
            self._pool = ConnectionPool(
                conninfo=database_url, min_size=1, max_size=pool_max_size,
                max_waiting=16, timeout=5, open=False,
                check=ConnectionPool.check_connection,
                kwargs={
                    "connect_timeout": 5,
                    "keepalives": 1,
                    "keepalives_idle": 5,
                    "keepalives_interval": 2,
                    "keepalives_count": 3,
                    "tcp_user_timeout": 8_000,
                    "options": "-c statement_timeout=5000",
                },
            )
            self._pool.open(wait=False)

    @contextmanager
    def _transaction_connection(self):
        if self._pool is not None:
            # ConnectionPool.connection provides a transaction boundary and
            # returns the connection to the bounded pool on exit.
            with self._pool.connection(timeout=5) as connection:
                yield connection
            return
        connection = self.connection_factory(self.database_url)
        try:
            with connection.transaction():
                yield connection
        finally:
            connection.close()

    @contextmanager
    def tenant_transaction(self, tenant_id: str) -> Iterator["_PostgresTransaction"]:
        with self._transaction_connection() as connection:
            connection.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
            yield _PostgresTransaction(connection, tenant_id)

    def quarantine(self, *, topic: str, partition: int, offset: int, reason: str, digest: str) -> None:
        # This bounded digest-only table is intentionally cell-level/cross-tenant,
        # like scoring_checkpoints; malformed events cannot safely enter tenant RLS.
        slot = offset % 1000
        with self._transaction_connection() as connection:
            connection.execute(
                """INSERT INTO quarantine_samples (slot, topic, partition_id, offset_id, reason_code, payload_sha256)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (topic, partition_id, slot) DO UPDATE SET
                     offset_id=EXCLUDED.offset_id,
                     reason_code=EXCLUDED.reason_code, payload_sha256=EXCLUDED.payload_sha256,
                     created_at=clock_timestamp()""",
                (slot, topic, partition, offset, reason[:80], digest),
            )

    def ping(self) -> bool:
        with self._transaction_connection() as connection:
            connection.execute("SELECT 1")
        return True

    def close(self) -> None:
        if self._pool is not None:
            self._pool.close(timeout=5)


class _PostgresTransaction:
    def __init__(self, connection: Any, tenant_id: str):
        self.connection, self.tenant_id = connection, tenant_id

    def prune_inbox(self, before: datetime) -> int:
        cursor = self.connection.execute(
            """DELETE FROM consumer_inbox WHERE ctid IN (
                   SELECT ctid FROM consumer_inbox
                   WHERE tenant_id=%s AND processed_at < %s
                   ORDER BY processed_at LIMIT %s
               )""",
            (self.tenant_id, before, INBOX_PRUNE_BATCH_SIZE),
        )
        return cursor.rowcount

    def prune_published_shadow_rows(self, before: datetime) -> int:
        """Delete a bounded set of expired published events and their predictions.

        Pending outbox rows are never selected. Prediction deletion is linked to
        the outbox envelope and happens only after its published row was deleted.
        """
        deleted = self.connection.execute(
            """WITH doomed AS MATERIALIZED (
                   SELECT event_id, payload #>> '{payload,prediction_id}' AS prediction_id
                   FROM ml_shadow_outbox
                   WHERE tenant_id=%s AND published_at IS NOT NULL AND created_at < %s
                   ORDER BY created_at, event_id
                   LIMIT %s FOR UPDATE SKIP LOCKED
               ), removed_events AS (
                   DELETE FROM ml_shadow_outbox AS outbox
                   USING doomed
                   WHERE outbox.tenant_id=%s AND outbox.event_id=doomed.event_id
                   RETURNING doomed.prediction_id
               ), removed_predictions AS (
                   DELETE FROM ml_shadow_predictions AS prediction
                   USING removed_events
                   WHERE prediction.tenant_id=%s
                     AND prediction.prediction_id=removed_events.prediction_id::uuid
                     AND prediction.created_at < %s
                   RETURNING prediction.prediction_id
               )
               SELECT count(*) FROM removed_events""",
            (self.tenant_id, before, SHADOW_RETENTION_BATCH_SIZE,
             self.tenant_id, self.tenant_id, before),
        ).fetchone()
        return int(deleted[0])

    def load_drift_status(self, model_name: str, model_version: str) -> dict[str, tuple[float, int]]:
        rows = self.connection.execute(
            """SELECT feature_name, psi, sample_count FROM ml_drift_status
               WHERE tenant_id=%s AND model_name=%s AND model_version=%s""",
            (self.tenant_id, model_name, model_version),
        ).fetchall()
        return {feature: (float(psi), int(sample_count)) for feature, psi, sample_count in rows
                if psi is not None}

    def load_drift_window(self, model_name: str, model_version: str,
                          feature_name: str) -> dict[str, object] | None:
        row = self.connection.execute(
            """SELECT psi, window_size, window_bins, bin_counts, seen_count,
                      last_update_count, window_state_version
               FROM ml_drift_status
               WHERE tenant_id=%s AND model_name=%s AND model_version=%s AND feature_name=%s""",
            (self.tenant_id, model_name, model_version, feature_name),
        ).fetchone()
        if row is None or row[6] is None:
            return None
        psi, window_size, raw_bins, counts, seen_count, last_update_count, version = row
        bins = _decode_drift_bins(bytes(raw_bins))
        return {"version": int(version), "window_size": int(window_size),
                "bins": bins, "counts": tuple(counts),
                "seen_count": int(seen_count), "last_update_count": int(last_update_count),
                "current_psi": float(psi) if psi is not None else None}

    def prune_drift_status(self, before: datetime) -> int:
        if before.tzinfo is None:
            raise ValueError("drift retention cutoff must be timezone-aware")
        deleted = self.connection.execute(
            """WITH doomed AS MATERIALIZED (
                   SELECT tenant_id, model_name, model_version, feature_name
                   FROM ml_drift_status
                   WHERE tenant_id=%s AND updated_at < %s
                   ORDER BY updated_at
                   LIMIT %s FOR UPDATE SKIP LOCKED
               )
               DELETE FROM ml_drift_status AS status
               USING doomed
               WHERE status.tenant_id=%s AND status.tenant_id=doomed.tenant_id
                 AND status.model_name=doomed.model_name
                 AND status.model_version=doomed.model_version
                 AND status.feature_name=doomed.feature_name
               RETURNING status.feature_name""",
            (self.tenant_id, before, DRIFT_RETENTION_BATCH_SIZE, self.tenant_id),
        ).fetchall()
        return len(deleted)

    def upsert_drift_status(self, model_name: str, model_version: str, feature_name: str,
                            psi: float | None, sample_count: int,
                            window_state: dict[str, object] | None = None) -> None:
        _validate_drift_status(model_name, model_version, feature_name, psi, sample_count, window_state)
        if window_state is None:
            window_size = bins = counts = seen_count = last_update_count = state_version = None
        else:
            window_size = window_state["window_size"]
            bins = _encode_drift_bins(window_state["bins"])
            counts = list(window_state["counts"])
            seen_count = window_state["seen_count"]
            last_update_count = window_state["last_update_count"]
            state_version = window_state["version"]
        self.connection.execute(
            """INSERT INTO ml_drift_status
               (tenant_id,model_name,model_version,feature_name,psi,sample_count,
                window_size,window_bins,bin_counts,seen_count,last_update_count,window_state_version)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (tenant_id,model_name,model_version,feature_name)
               DO UPDATE SET psi=EXCLUDED.psi,sample_count=EXCLUDED.sample_count,
                             window_size=EXCLUDED.window_size,window_bins=EXCLUDED.window_bins,
                             bin_counts=EXCLUDED.bin_counts,seen_count=EXCLUDED.seen_count,
                             last_update_count=EXCLUDED.last_update_count,
                             window_state_version=EXCLUDED.window_state_version,
                             updated_at=clock_timestamp()""",
            (self.tenant_id, model_name, model_version, feature_name, psi, sample_count,
             window_size, bins, counts, seen_count, last_update_count, state_version),
        )

    def claim_event(self, event: TelemetryEvent, *, topic: str, partition: int, offset: int) -> bool:
        cursor = self.connection.execute(
            """INSERT INTO consumer_inbox (tenant_id, event_id, payload_sha256, topic, partition_id, offset_id)
               VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (tenant_id, event_id) DO NOTHING RETURNING event_id""",
            (self.tenant_id, event.event_id, event.digest, topic, partition, offset),
        )
        if cursor.fetchone() is not None:
            return True
        prior = self.connection.execute(
            "SELECT payload_sha256 FROM consumer_inbox WHERE tenant_id=%s AND event_id=%s",
            (self.tenant_id, event.event_id),
        ).fetchone()
        if prior is None or prior[0] != event.digest:
            raise DuplicateEventConflict("event ID replayed with a different content digest")
        return False

    def load_bin_state(self, bin_id: str) -> dict[str, Any]:
        self.connection.execute(
            """INSERT INTO bin_window_state (tenant_id, bin_id, state, last_source_event_seq)
               VALUES (%s, %s, '{"devices":{}}'::jsonb, 0) ON CONFLICT DO NOTHING""",
            (self.tenant_id, bin_id),
        )
        row = self.connection.execute(
            "SELECT state FROM bin_window_state WHERE tenant_id=%s AND bin_id=%s FOR UPDATE",
            (self.tenant_id, bin_id),
        ).fetchone()
        if row is None:
            raise RuntimeError("RLS hid or failed to create the tenant bin-window row")
        return row[0] if isinstance(row[0], dict) else json.loads(row[0])

    def save_bin_state(self, bin_id: str, state: dict[str, Any], source_sequence: int) -> None:
        payload = json.dumps(state, sort_keys=True, separators=(",", ":"), allow_nan=False)
        self.connection.execute(
            """UPDATE bin_window_state SET state=%s::jsonb,
                 last_source_event_seq=GREATEST(last_source_event_seq,%s),
                 revision=revision+1, updated_at=clock_timestamp()
               WHERE tenant_id=%s AND bin_id=%s""",
            (payload, source_sequence, self.tenant_id, bin_id),
        )

    def write_shadow_prediction(self, prediction: ShadowPrediction,
                                event: dict[str, object]) -> bool:
        if prediction.tenant_id != self.tenant_id or prediction.status != "shadow":
            raise RuntimeError("shadow write tenant/mode mismatch")
        result = self.connection.execute(
            """INSERT INTO ml_shadow_predictions
                 (tenant_id, prediction_id, subject_id, window_end, model_name, model_version,
                  feature_set_version, revision, probability, feature_digest, status, data_origin)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT DO NOTHING RETURNING prediction_id""",
            (prediction.tenant_id, prediction.prediction_id, prediction.subject_id,
             prediction.window_end, prediction.model_name, prediction.model_version,
             prediction.feature_set_version, prediction.revision, prediction.probability,
             prediction.feature_digest, prediction.status, prediction.data_origin),
        )
        if result.fetchone() is None:
            return False
        self.connection.execute(
            "INSERT INTO ml_shadow_outbox (tenant_id, event_id, payload) VALUES (%s, %s, %s::jsonb)",
            (prediction.tenant_id, event["event_id"],
             json.dumps(event, sort_keys=True, separators=(",", ":"), allow_nan=False)),
        )
        return True

    def claim_pending_shadow_events(self, limit: int, lease_seconds: int) -> tuple[str, list[dict[str, Any]]]:
        if not 1 <= limit <= 100 or lease_seconds < 1:
            raise ValueError("shadow outbox claim bounds are invalid")
        token = str(uuid.uuid4())
        rows = self.connection.execute(
            """WITH pending AS MATERIALIZED (
                   SELECT event_id FROM ml_shadow_outbox
                   WHERE tenant_id=%s AND published_at IS NULL
                     AND (lease_until IS NULL OR lease_until <= clock_timestamp())
                   ORDER BY created_at, event_id LIMIT %s FOR UPDATE SKIP LOCKED
               ), claimed AS (
                   UPDATE ml_shadow_outbox AS outbox SET lease_token=%s,
                       lease_until=clock_timestamp() + (%s * interval '1 second'),
                       attempt_count=attempt_count+1, last_error=NULL
                   FROM pending
                   WHERE outbox.tenant_id=%s AND outbox.event_id=pending.event_id
                   RETURNING outbox.event_id, outbox.payload, outbox.created_at
               )
               SELECT event_id, payload FROM claimed ORDER BY created_at, event_id""",
            (self.tenant_id, limit, token, lease_seconds, self.tenant_id),
        ).fetchall()
        return token, [{"event_id": str(event_id), "payload": payload} for event_id, payload in rows]

    def mark_shadow_event_published(self, event_id: str, lease_token: str) -> bool:
        cursor = self.connection.execute(
            """UPDATE ml_shadow_outbox SET published_at=clock_timestamp(),
                   lease_token=NULL, lease_until=NULL
               WHERE tenant_id=%s AND event_id=%s AND lease_token=%s AND published_at IS NULL""",
            (self.tenant_id, event_id, lease_token),
        )
        return cursor.rowcount == 1

    def release_shadow_event(self, event_id: str, lease_token: str, error: str) -> bool:
        cursor = self.connection.execute(
            """UPDATE ml_shadow_outbox SET lease_token=NULL, lease_until=NULL,
                   last_error=%s
               WHERE tenant_id=%s AND event_id=%s AND lease_token=%s AND published_at IS NULL""",
            (error[:500], self.tenant_id, event_id, lease_token),
        )
        return cursor.rowcount == 1
