"""PostgreSQL access for greenguard_risk.

Every tenant transaction sets ``app.tenant_id`` with ``set_config(..., true)`` so the
setting is transaction-local and safe behind PgBouncer transaction pooling. Queries
also filter by tenant explicitly (defence in depth over forced RLS).
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from risk_engine.join import Binding, Interval
from risk_engine.policy import PolicyVersion, validate_policy

TRANSIENT = "transient"
REJECTED = "rejected"
HARD = "hard"
_TRANSIENT_STATES = frozenset({"40001", "40P01", "55P03", "57014", "57P01", "57P02", "57P03"})
_TRANSIENT_CLASSES = ("08", "53")


class StoreError(Exception):
    """A database failure with its SQLSTATE (None when the connection itself failed)."""

    def __init__(self, sqlstate: str | None, message: str):
        super().__init__(f"{sqlstate or 'connection'}: {message}")
        self.sqlstate = sqlstate


def classify(error: StoreError) -> str:
    """Transient errors retry; data rejections quarantine; everything else stops.

    42501 (RLS / permission) is deliberately HARD: quarantining it would hide a
    tenant-isolation bug.
    """
    state = error.sqlstate
    if state is None or state in _TRANSIENT_STATES or state.startswith(_TRANSIENT_CLASSES):
        return TRANSIENT
    if state == "42501":
        return HARD
    if state.startswith(("22", "23")):
        return REJECTED
    return HARD


@dataclass(frozen=True)
class InboxEntry:
    consumer_name: str
    event_id: str
    event_type: str
    topic: str
    partition: int
    offset: int
    sha256: str
    event: Mapping[str, Any]


@dataclass(frozen=True)
class LotRow:
    bin_id: str
    occupancy_version: int
    site_id: str
    lot_id: str
    grain_type: str
    variety: str | None
    effective_from: datetime
    previous_lot_id: str | None
    source_event_id: str


def _binding(row: Sequence[Any] | None) -> Binding | None:
    if row is None:
        return None
    return Binding(str(row[0]), _text(row[1]), _text(row[2]), row[3], row[4], row[5])


def _text(value: object) -> str | None:
    return None if value is None else str(value)


def _interval(row: Sequence[Any]) -> Interval:
    return Interval(str(row[0]), row[1], str(row[2]), row[3], row[4], row[5])


_INTERVAL_COLUMNS = "bin_id, occupancy_version, lot_id, grain_type, effective_from, effective_to"
_ASSESSMENT_COLUMNS = ("assessment_id", "source_event_id", "reading_id", "device_id", "bin_id",
                       "lot_id", "occupancy_version", "grain_type", "policy_version", "score",
                       "severity", "alert_eligible", "reasons", "observed_at", "event_id",
                       "aggregate_version", "correlation_id", "causation_id", "traceparent",
                       "policy_id", "policy_calibrated", "policy_provenance")


class PgTx:
    """Statements used inside one tenant transaction."""

    def __init__(self, cursor: Any, tenant_id: str):
        self.cur, self.tenant = cursor, tenant_id

    def _one(self, sql: str, params: Sequence[Any]) -> Sequence[Any] | None:
        self.cur.execute(sql, params)
        return self.cur.fetchone()

    def inbox_insert(self, entry: InboxEntry) -> str | None:
        """Insert the receipt; return None if new, else the stored payload digest."""
        row = self._one(
            "INSERT INTO consumer_inbox (consumer_name, tenant_id, event_id, event_type, source_topic,"
            " source_partition, source_offset, event_sha256, event) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)"
            " ON CONFLICT DO NOTHING RETURNING event_id",
            (entry.consumer_name, self.tenant, entry.event_id, entry.event_type, entry.topic,
             entry.partition, entry.offset, entry.sha256, json.dumps(entry.event)))
        if row is not None:
            return None
        existing = self._one(
            "SELECT event_sha256 FROM consumer_inbox WHERE consumer_name = %s AND tenant_id = %s"
            " AND event_id = %s", (entry.consumer_name, self.tenant, entry.event_id))
        return str(existing[0]) if existing else ""

    def binding_for_update(self, device_id: str) -> Binding | None:
        return _binding(self._one(
            "SELECT device_id, site_id, bin_id, status, inventory_version, binding_version"
            " FROM device_bindings WHERE tenant_id = %s AND device_id = %s FOR UPDATE",
            (self.tenant, device_id)))

    def binding_upsert(self, binding: Binding, source_event_id: str) -> None:
        self.cur.execute(
            "INSERT INTO device_bindings (tenant_id, device_id, site_id, bin_id, status,"
            " inventory_version, binding_version, source_event_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)"
            " ON CONFLICT (tenant_id, device_id) DO UPDATE SET site_id = EXCLUDED.site_id,"
            " bin_id = EXCLUDED.bin_id, status = EXCLUDED.status,"
            " inventory_version = EXCLUDED.inventory_version, binding_version = EXCLUDED.binding_version,"
            " source_event_id = EXCLUDED.source_event_id, applied_at = clock_timestamp()"
            " WHERE device_bindings.inventory_version < EXCLUDED.inventory_version",
            (self.tenant, binding.device_id, binding.site_id, binding.bin_id, binding.status,
             binding.inventory_version, binding.binding_version, source_event_id))

    def lock_bin(self, bin_id: str) -> None:
        self.cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 6))",
                         (f"{self.tenant}:{bin_id}",))

    def lot_version(self, bin_id: str, occupancy_version: int) -> LotRow | None:
        row = self._one(
            "SELECT bin_id, occupancy_version, site_id, lot_id, grain_type, variety, effective_from,"
            " previous_lot_id, source_event_id FROM bin_lot_intervals"
            " WHERE tenant_id = %s AND bin_id = %s AND occupancy_version = %s",
            (self.tenant, bin_id, occupancy_version))
        if row is None:
            return None
        return LotRow(str(row[0]), row[1], str(row[2]), str(row[3]), row[4], row[5], row[6],
                      _text(row[7]), str(row[8]))

    def open_interval(self, bin_id: str) -> Interval | None:
        row = self._one(
            f"SELECT {_INTERVAL_COLUMNS} FROM bin_lot_intervals"
            " WHERE tenant_id = %s AND bin_id = %s ORDER BY occupancy_version DESC LIMIT 1",
            (self.tenant, bin_id))
        return None if row is None else _interval(row)

    def close_interval(self, bin_id: str, occupancy_version: int, effective_to: datetime) -> None:
        self.cur.execute(
            "UPDATE bin_lot_intervals SET effective_to = %s WHERE tenant_id = %s AND bin_id = %s"
            " AND occupancy_version = %s AND effective_to IS NULL",
            (effective_to, self.tenant, bin_id, occupancy_version))

    def insert_interval(self, lot: LotRow) -> None:
        self.cur.execute(
            "INSERT INTO bin_lot_intervals (tenant_id, bin_id, occupancy_version, site_id, lot_id,"
            " grain_type, variety, effective_from, previous_lot_id, source_event_id)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (self.tenant, lot.bin_id, lot.occupancy_version, lot.site_id, lot.lot_id, lot.grain_type,
             lot.variety, lot.effective_from, lot.previous_lot_id, lot.source_event_id))

    def intervals_covering(self, bin_id: str, instant: datetime) -> list[Interval]:
        self.cur.execute(
            f"SELECT {_INTERVAL_COLUMNS} FROM bin_lot_intervals WHERE tenant_id = %s AND bin_id = %s"
            " AND tstzrange(effective_from, effective_to, '[)') @> %s::timestamptz",
            (self.tenant, bin_id, instant))
        return [_interval(row) for row in self.cur.fetchall()]

    def assessments_after(self, bin_id: str, lot_id: str, instant: datetime) -> list[Mapping[str, Any]]:
        self.cur.execute(
            "SELECT a.assessment_id, a.device_id, a.reading_id, a.source_event_id, a.observed_at"
            " FROM risk_assessments a WHERE a.tenant_id = %s AND a.bin_id = %s"
            " AND a.lot_id = %s AND a.observed_at >= %s"
            " AND NOT EXISTS (SELECT 1 FROM risk_assessment_invalidations i"
            " WHERE i.tenant_id = a.tenant_id AND i.assessment_id = a.assessment_id)"
            " ORDER BY a.observed_at, a.assessment_id",
            (self.tenant, bin_id, lot_id, instant))
        keys = ("assessment_id", "device_id", "reading_id", "source_event_id", "observed_at")
        return [dict(zip(keys, row)) for row in self.cur.fetchall()]

    def insert_invalidation(self, assessment_id: str, event_id: str, replacement_lot_id: str,
                            replacement_occupancy_version: int, source_event_id: str) -> None:
        self.cur.execute(
            "INSERT INTO risk_assessment_invalidations (tenant_id, assessment_id, event_id,"
            " replacement_lot_id, replacement_occupancy_version, source_event_id)"
            " VALUES (%s,%s,%s,%s,%s,%s)",
            (self.tenant, assessment_id, event_id, replacement_lot_id,
             replacement_occupancy_version, source_event_id))

    def assessment(self, source_event_id: str, lot_id: str, policy_version: int,
                   policy_id: str | None = None) -> Mapping[str, Any] | None:
        if policy_id is None:
            row = self._one(
                f"SELECT {', '.join(_ASSESSMENT_COLUMNS)} FROM risk_assessments WHERE tenant_id = %s"
                " AND source_event_id = %s AND lot_id = %s AND policy_version = %s",
                (self.tenant, source_event_id, lot_id, policy_version))
        else:
            row = self._one(
                f"SELECT {', '.join(_ASSESSMENT_COLUMNS)} FROM risk_assessments WHERE tenant_id = %s"
                " AND source_event_id = %s AND lot_id = %s AND policy_version = %s AND policy_id = %s",
                (self.tenant, source_event_id, lot_id, policy_version, policy_id))
        return None if row is None else dict(zip(_ASSESSMENT_COLUMNS, row))

    def legacy_assessment(self, source_event_id: str, lot_id: str,
                          policy_version: int) -> Mapping[str, Any] | None:
        row = self._one(
            f"SELECT {', '.join(_ASSESSMENT_COLUMNS)} FROM risk_assessments WHERE tenant_id = %s"
            " AND source_event_id = %s AND lot_id = %s AND policy_version = %s AND policy_id IS NULL",
            (self.tenant, source_event_id, lot_id, policy_version))
        return None if row is None else dict(zip(_ASSESSMENT_COLUMNS, row))

    def next_stream_version(self, device_id: str) -> int:
        row = self._one(
            "INSERT INTO device_risk_streams (tenant_id, device_id, last_version) VALUES (%s,%s,1)"
            " ON CONFLICT (tenant_id, device_id) DO UPDATE"
            " SET last_version = device_risk_streams.last_version + 1 RETURNING last_version",
            (self.tenant, device_id))
        return int(row[0]) if row else 0

    def insert_assessment(self, values: Mapping[str, Any]) -> None:
        columns = ("tenant_id",) + _ASSESSMENT_COLUMNS
        params = [self.tenant] + [json.dumps(values[c]) if c in {"reasons", "policy_provenance"} else values[c]
                                  for c in _ASSESSMENT_COLUMNS]
        self.cur.execute(
            f"INSERT INTO risk_assessments ({', '.join(columns)})"
            f" VALUES ({', '.join(['%s'] * len(columns))})", params)

    def insert_outbox(self, event: Mapping[str, Any]) -> None:
        self.cur.execute(
            "INSERT INTO outbox_events (event_id, tenant_id, aggregate_type, aggregate_id,"
            " aggregate_version, event_type, schema_version, occurred_at, correlation_id,"
            " causation_id, traceparent, payload) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (event["event_id"], self.tenant, event["aggregate_type"], event["aggregate_id"],
             int(event["aggregate_version"]), event["event_type"], event["schema_version"],
             event["occurred_at"], event["correlation_id"], event["causation_id"],
             event["traceparent"], json.dumps(event["payload"])))

    def select_policy(self, bin_id: str, grain_type: str, instant: datetime) -> PolicyVersion | None:
        """Choose the bin-specific policy, falling back to a grain-wide policy."""
        row = self._one(
            "SELECT policy_id, policy_version, grain_type, bin_id, effective_from, effective_to,"
            " measurement_thresholds, risk_thresholds, calibrated, policy_status, provenance,"
            " calibration_evidence, approved_by, approved_at"
            " FROM grain_policies WHERE tenant_id = %s AND grain_type = %s AND policy_status = 'active'"
            " AND (bin_id = %s OR bin_id IS NULL) AND effective_from <= %s"
            " AND (effective_to IS NULL OR %s < effective_to)"
            " ORDER BY (bin_id IS NOT NULL) DESC, effective_from DESC, policy_version DESC LIMIT 1",
            (self.tenant, grain_type, bin_id, instant, instant))
        if row is None:
            return None
        def mapping(value: Any) -> Mapping[str, Any]:
            return json.loads(value) if isinstance(value, str) else value
        policy = PolicyVersion(self.tenant, str(row[0]), int(row[1]), str(row[2]),
                               _text(row[3]), row[4], row[5], mapping(row[6]), mapping(row[7]),
                               bool(row[8]), str(row[9]), mapping(row[10]), _text(row[11]),
                               _text(row[12]), row[13])
        validate_policy(policy)
        return policy

    def create_policy(self, policy: PolicyVersion, event: Mapping[str, Any]) -> None:
        """Insert one immutable version and its owner event atomically."""
        validate_policy(policy)
        self.cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 10))",
                         (f"{self.tenant}:{policy.grain_type}:{policy.bin_id or '*'}",))
        self.cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 11))",
                         (f"{self.tenant}:{policy.policy_id}",))
        superseded = None
        if policy.status == "active":
            self.cur.execute(
                "SELECT policy_id, policy_version, effective_from FROM grain_policies"
                " WHERE tenant_id = %s AND grain_type = %s AND bin_id IS NOT DISTINCT FROM %s"
                " AND policy_status = 'active' AND effective_to IS NULL FOR UPDATE",
                (self.tenant, policy.grain_type, policy.bin_id))
            for old_policy_id, old_version, old_from in self.cur.fetchall():
                if old_from >= policy.effective_from:
                    continue
                self.cur.execute(
                    "UPDATE grain_policies SET effective_to = %s WHERE tenant_id = %s"
                    " AND policy_id = %s AND policy_version = %s AND effective_to IS NULL",
                    (policy.effective_from, self.tenant, old_policy_id, old_version))
                superseded = {"policy_id": str(old_policy_id), "version": str(old_version)}
        if isinstance(event, dict):
            event["payload"]["supersedes"] = superseded
        row = self._one("SELECT COALESCE(MAX(policy_version), 0) FROM grain_policies"
                        " WHERE tenant_id = %s AND policy_id = %s",
                        (self.tenant, policy.policy_id))
        if not row or policy.version != int(row[0]) + 1:
            raise StoreError("23514", "policy version must increase by one")
        self.cur.execute(
            "INSERT INTO grain_policies (tenant_id, policy_id, policy_version, grain_type, bin_id,"
            " effective_from, effective_to, measurement_thresholds, risk_thresholds, calibrated,"
            " policy_status, provenance, calibration_evidence, approved_by, approved_at, created_by)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (self.tenant, policy.policy_id, policy.version, policy.grain_type, policy.bin_id,
             policy.effective_from, policy.effective_to, json.dumps(policy.measurement_thresholds),
             json.dumps(policy.risk_thresholds), policy.calibrated, policy.status,
             json.dumps(policy.provenance), policy.calibration_evidence, policy.approved_by,
             policy.approved_at, str(policy.provenance.get("created_by", "risk-policy-api"))))
        self.insert_outbox(event)


def _connect(conninfo: str) -> Any:
    import psycopg  # imported lazily so pure-logic tests need no driver

    # prepare_threshold=None: no server-side prepared statements behind PgBouncer.
    return psycopg.connect(conninfo, autocommit=True, prepare_threshold=None, connect_timeout=3)


def _driver_error() -> type[BaseException]:
    import psycopg

    return psycopg.Error


class PgDatabase:
    """One lazily (re)opened connection; each unit of work is one transaction."""

    def __init__(self, conninfo: str, connect: Callable[[str], Any] = _connect,
                 driver_error: Callable[[], type[BaseException]] = _driver_error):
        self._conninfo, self._connect, self._driver_error = conninfo, connect, driver_error
        self._conn: Any = None
        self._lock = threading.RLock()

    def _connection(self) -> Any:
        if self._conn is None or self._conn.closed:
            self._conn = self._connect(self._conninfo)
        return self._conn

    @contextmanager
    def _guard(self) -> Iterator[None]:
        driver_error = self._driver_error()
        with self._lock:
            try:
                yield
            except driver_error as exc:
                state = getattr(exc, "sqlstate", None)
                if state is None and self._conn is not None:
                    self._conn.close()
                raise StoreError(state, str(exc).strip()) from exc

    @contextmanager
    def transaction(self, tenant_id: str, placement: Mapping[str, str] | None = None) -> Iterator[PgTx]:
        with self._guard():
            conn = self._connection()
            with conn.transaction(), conn.cursor() as cur:
                cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                if placement is not None:
                    expires = datetime.fromisoformat(placement["expiresAt"].replace("Z", "+00:00"))
                    if expires.timestamp() <= time.time():
                        raise StoreError(None, "placement lease expired before database admission")
                    cur.execute("SET LOCAL statement_timeout = '4s'")
                    cur.execute("SET LOCAL lock_timeout = '2s'")
                    for name, value in (("app.shard_id", placement["shardId"]),
                                        ("app.shard_incarnation", placement["shardIncarnation"]),
                                        ("app.placement_epoch", placement["placementEpoch"])):
                        cur.execute("SELECT set_config(%s, %s, true)", (name, value))
                    try:
                        cur.execute("SELECT greenguard_internal.admit_tenant_placement"
                                    "(%s::uuid,%s::text,%s::uuid,%s::bigint)",
                                    (tenant_id, placement["shardId"], placement["shardIncarnation"],
                                     placement["placementEpoch"]))
                    except self._driver_error() as exc:
                        # Only the admission function's precise stale-owner denial
                        # is retryable. Business RLS/permissions still stop the worker.
                        if (getattr(exc, "sqlstate", None) == "42501"
                                and getattr(getattr(exc, "diag", None), "message_primary", None)
                                == "tenant placement is missing, stale, or fenced"):
                            raise StoreError("55P03", "tenant placement changed before admission") from None
                        raise
                yield PgTx(cur, tenant_id)

    def quarantine(self, consumer_name: str, topic: str, partition: int, offset: int,
                   reason: str, payload_sha256: str) -> None:
        with self._guard():
            self._connection().execute(
                "INSERT INTO quarantine_samples (consumer_name, source_topic, source_partition, slot,"
                " source_offset, reason, payload_sha256) VALUES (%s,%s,%s,%s,%s,%s,%s)"
                " ON CONFLICT (consumer_name, source_topic, source_partition, slot) DO UPDATE"
                " SET source_offset = EXCLUDED.source_offset, reason = EXCLUDED.reason,"
                " payload_sha256 = EXCLUDED.payload_sha256, quarantined_at = clock_timestamp()",
                (consumer_name, topic, partition, offset % 1000, offset, reason, payload_sha256))

    def ping(self) -> bool:
        try:
            with self._guard():
                self._connection().execute("SELECT 1")
            return True
        except StoreError:
            return False

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
