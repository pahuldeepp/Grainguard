"""Apply one consumed record in exactly one tenant transaction.

Inbox receipt, local-state change or assessment, and the ``risk.assessed`` outbox row
commit together or not at all. The caller commits the Kafka offset only after this
returns a committed outcome or after a confirmed quarantine.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, ContextManager, Mapping, Protocol

from risk_engine import anomaly as anomaly_policy
from risk_engine import events
from risk_engine.anomaly import AnomalyPolicy
from risk_engine.events import Anomaly, BindingChange, LotChange, Telemetry
from risk_engine.join import (BINDING_STATE_UNAVAILABLE, Binding, NotReady, Reading, Reject, Selected, Skip,
                              select_lot)
from risk_engine.scoring import POLICIES, Policy, assess
from risk_engine.store import HARD, REJECTED, TRANSIENT, InboxEntry, LotRow, StoreError, classify

APPLIED = "applied"
DUPLICATE = "duplicate"
STALE = "stale"
SKIPPED = "skipped"
NOT_READY = "not_ready"
QUARANTINE = "quarantine"

# Stable identity namespace; changing it would re-mint every assessment and event ID.
RISK_NAMESPACE = uuid.UUID("5d0a7a52-6a2e-4b8e-9f37-2f1c0b6e9d41")
DEVICE_ID = "device_id"
ASSESSMENT_ID = "assessment_id"
EVENT_ID = "event_id"


@dataclass(frozen=True)
class Record:
    topic: str
    partition: int
    offset: int
    value: bytes | None
    key: bytes | None = None


@dataclass(frozen=True)
class Result:
    outcome: str
    reason: str | None = None
    event_id: str | None = None
    assessment_id: str | None = None
    late_assessments: int = 0


class Tx(Protocol):
    def inbox_insert(self, entry: InboxEntry) -> str | None: ...
    def binding_for_update(self, device_id: str) -> Binding | None: ...
    def binding_upsert(self, binding: Binding, source_event_id: str) -> None: ...
    def lock_bin(self, bin_id: str) -> None: ...
    def lot_version(self, bin_id: str, occupancy_version: int) -> LotRow | None: ...
    def open_interval(self, bin_id: str) -> Any: ...
    def close_interval(self, bin_id: str, occupancy_version: int, effective_to: datetime) -> None: ...
    def insert_interval(self, lot: LotRow) -> None: ...
    def intervals_covering(self, bin_id: str, instant: datetime) -> list[Any]: ...
    def assessments_after(self, bin_id: str, lot_id: str, instant: datetime) -> list[Mapping[str, Any]]: ...
    def insert_invalidation(self, assessment_id: str, event_id: str, replacement_lot_id: str,
                            replacement_occupancy_version: int, source_event_id: str) -> None: ...
    def assessment(self, source_event_id: str, lot_id: str, policy_version: int) -> Mapping[str, Any] | None: ...
    def next_stream_version(self, device_id: str) -> int: ...
    def insert_assessment(self, values: Mapping[str, Any]) -> None: ...
    def insert_outbox(self, event: Mapping[str, Any]) -> None: ...
    def latest_assessment(self, device_id: str, lot_id: str, not_before: datetime,
                          source_kind: str | None) -> Mapping[str, Any] | None: ...
    def insert_anomaly_decision(self, values: Mapping[str, Any]) -> None: ...
    def bin_published_score(self, bin_id: str, lot_id: str) -> int | None: ...
    def telemetry_received(self, source_event_id: str, device_id: str, reading_id: str) -> bool: ...
    def telemetry_rejected(self, source_event_id: str, device_id: str, reading_id: str) -> bool: ...


class Database(Protocol):
    def transaction(self, tenant_id: str) -> ContextManager[Tx]: ...


@dataclass(frozen=True)
class RetryPolicy:
    attempts: int = 5
    base_delay_s: float = 0.2
    max_delay_s: float = 5.0

    def delay(self, attempt: int) -> float:
        return min(self.base_delay_s * (2 ** attempt), self.max_delay_s)


class TransientExhausted(RuntimeError):
    """Bounded retries failed; stop without committing the offset."""


class _Rollback(Exception):
    def __init__(self, result: Result):
        super().__init__(result.outcome)
        self.result = result


def deterministic_ids(tenant_id: str, source_event_id: str, lot_id: str, policy_version: int) -> tuple[str, str]:
    identity = f"{tenant_id}:{source_event_id}:{lot_id}:{policy_version}"
    return (str(uuid.uuid5(RISK_NAMESPACE, f"risk.assessed:{identity}")),
            str(uuid.uuid5(RISK_NAMESPACE, f"assessment:{identity}")))


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Applier:
    def __init__(self, db: Database, consumer_name: str,
                 lot_feed_watermark: Callable[[], datetime | None],
                 policies: Mapping[str, Policy] = POLICIES, retry: RetryPolicy = RetryPolicy(),
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], datetime] = _utc_now,
                 anomaly: AnomalyPolicy = AnomalyPolicy()):
        self.db, self.consumer_name, self.watermark = db, consumer_name, lot_feed_watermark
        self.policies, self.retry, self.sleep, self.clock = policies, retry, sleep, clock
        self.anomaly = anomaly

    def apply(self, record: Record, event: Telemetry | BindingChange | LotChange | Anomaly) -> Result:
        for attempt in range(self.retry.attempts):
            try:
                return self._once(record, event)
            except _Rollback as rollback:
                return rollback.result
            except StoreError as error:
                kind = classify(error)
                if kind == REJECTED:
                    return Result(QUARANTINE, "db_rejected")
                if kind == HARD or attempt + 1 == self.retry.attempts:
                    raise self._stop(kind, error) from error
                self.sleep(self.retry.delay(attempt))
        raise TransientExhausted("retry policy allows no attempts")

    @staticmethod
    def _stop(kind: str, error: StoreError) -> StoreError | TransientExhausted:
        if kind == TRANSIENT:
            return TransientExhausted(f"transient database failures exhausted: {error}")
        return error

    def _once(self, record: Record, event: Telemetry | BindingChange | LotChange | Anomaly) -> Result:
        envelope = event.envelope
        # The decision ledger is global across Kafka group names. Use the same scope for
        # receipts, including skipped decisions and conflicting payloads on replay.
        consumer = "risk-engine.anomaly.v1" if isinstance(event, Anomaly) else self.consumer_name
        entry = InboxEntry(consumer, envelope.event_id, envelope.event_type, record.topic,
                           record.partition, record.offset, envelope.sha256, envelope.raw)
        with self.db.transaction(envelope.tenant_id) as tx:
            existing = tx.inbox_insert(entry)
            if existing is not None:
                if existing != entry.sha256:
                    raise _Rollback(Result(QUARANTINE, "event_id_conflict"))
                return Result(DUPLICATE)
            if isinstance(event, Telemetry):
                return self._telemetry(tx, event)
            if isinstance(event, BindingChange):
                return self._binding(tx, event)
            if isinstance(event, Anomaly):
                return self._anomaly(tx, event)
            return self._lot(tx, event)

    def _binding(self, tx: Tx, change: BindingChange) -> Result:
        envelope = change.envelope
        current = tx.binding_for_update(change.device_id)
        if current is not None and current.inventory_version >= envelope.aggregate_version:
            return Result(STALE)
        base = current or Binding(change.device_id, None, None, None, 0, change.binding_version)
        merged = replace(base, inventory_version=envelope.aggregate_version,
                         binding_version=max(base.binding_version, change.binding_version),
                         **dict(change.fields))
        tx.binding_upsert(merged, envelope.event_id)
        return Result(APPLIED)

    def _lot(self, tx: Tx, change: LotChange) -> Result:
        tx.lock_bin(change.bin_id)
        row = LotRow(change.bin_id, change.occupancy_version, change.site_id, change.lot_id,
                     change.grain_type, change.variety, change.effective_from,
                     change.previous_lot_id, change.envelope.event_id)
        known = tx.lot_version(change.bin_id, change.occupancy_version)
        if known is not None:
            if replace(known, source_event_id=row.source_event_id) != row:
                raise _Rollback(Result(QUARANTINE, "lot_version_conflict"))
            return Result(STALE)
        latest = tx.open_interval(change.bin_id)
        if latest is not None:
            if change.occupancy_version < latest.occupancy_version:
                return Result(STALE)
            if change.occupancy_version > latest.occupancy_version + 1:
                raise _Rollback(Result(NOT_READY, "lot_predecessor_missing"))
            if change.previous_lot_id != latest.lot_id:
                raise _Rollback(Result(QUARANTINE, "lot_predecessor_mismatch"))
            tx.close_interval(change.bin_id, latest.occupancy_version, change.effective_from)
        tx.insert_interval(row)
        late = 0
        if change.previous_lot_id is not None:
            affected = tx.assessments_after(change.bin_id, change.previous_lot_id, change.effective_from)
            for assessment in affected:
                event_id = str(uuid.uuid5(RISK_NAMESPACE,
                                          f"risk.assessment_invalidated:{assessment[ASSESSMENT_ID]}"))
                version = tx.next_stream_version(str(assessment[DEVICE_ID]))
                tx.insert_invalidation(str(assessment[ASSESSMENT_ID]), event_id, change.lot_id,
                                       change.occupancy_version, change.envelope.event_id)
                tx.insert_outbox(build_invalidation_event(change, assessment, event_id, version, self.clock()))
            late = len(affected)
        return Result(APPLIED, late_assessments=late)

    def _telemetry(self, tx: Tx, reading: Telemetry) -> Result:
        binding = tx.binding_for_update(reading.device_id)
        if reading.bin_id is not None:
            # Serialize scoring with lot replacement. Otherwise a concurrent reading
            # could commit on the old lot after the invalidation query has run.
            tx.lock_bin(reading.bin_id)
        intervals = [] if reading.bin_id is None else tx.intervals_covering(reading.bin_id, reading.observed_at)
        choice = select_lot(Reading(reading.bin_id, reading.binding_version, reading.observed_at),
                            binding, intervals, self.watermark())
        if isinstance(choice, NotReady):
            raise _Rollback(Result(NOT_READY, choice.reason))
        if isinstance(choice, Reject):
            raise _Rollback(Result(QUARANTINE, choice.reason))
        if isinstance(choice, Skip):
            return Result(SKIPPED, choice.reason)
        return self._score(tx, reading, choice)

    def _score(self, tx: Tx, reading: Telemetry, choice: Selected) -> Result:
        interval = choice.interval
        policy = self.policies.get(interval.grain_type)
        if policy is None:
            raise _Rollback(Result(QUARANTINE, "policy_unavailable"))
        try:
            result = assess(reading.measurements, interval.grain_type, policy)
        except ValueError:
            raise _Rollback(Result(QUARANTINE, "invalid_measurements")) from None
        envelope = reading.envelope
        existing = tx.assessment(envelope.event_id, interval.lot_id, policy.version)
        if existing is not None:
            return Result(DUPLICATE, event_id=str(existing[EVENT_ID]),
                          assessment_id=str(existing[ASSESSMENT_ID]))
        event_id, assessment_id = deterministic_ids(envelope.tenant_id, envelope.event_id,
                                                    interval.lot_id, policy.version)
        version = tx.next_stream_version(reading.device_id)
        values = {
            ASSESSMENT_ID: assessment_id, "source_event_id": envelope.event_id,
            "reading_id": reading.reading_id, DEVICE_ID: reading.device_id,
            "bin_id": interval.bin_id, "lot_id": interval.lot_id,
            "occupancy_version": interval.occupancy_version, "grain_type": interval.grain_type,
            "policy_version": policy.version, "score": result.score, "severity": result.severity,
            "alert_eligible": result.alert_eligible, "reasons": list(result.reasons),
            "observed_at": reading.observed_at, EVENT_ID: event_id, "aggregate_version": version,
            "correlation_id": envelope.correlation_id, "causation_id": envelope.event_id,
            "traceparent": envelope.traceparent,
        }
        tx.insert_assessment(values)
        tx.insert_outbox(build_event(envelope.tenant_id, values, self.clock()))
        return Result(APPLIED, event_id=event_id, assessment_id=assessment_id)


    # ------------------------------------------------------------------ advisory anomalies (ADR-0031)

    def _anomaly(self, tx: Tx, found: Anomaly) -> Result:
        """Add advisory risk for a Flink anomaly; never lower or replace the threshold decision."""
        if (self.clock() - found.observed_at).total_seconds() > self.anomaly.max_age_s:
            return self._not_published(tx, found, anomaly_policy.OUTCOME_TOO_OLD)
        binding = tx.binding_for_update(found.device_id)
        if binding is None:
            raise _Rollback(Result(NOT_READY, BINDING_STATE_UNAVAILABLE))
        if found.bin_id is None or binding.bin_id is None:
            return self._not_published(tx, found, anomaly_policy.OUTCOME_DEVICE_UNBOUND)
        if binding.status != "active":
            return self._not_published(tx, found, anomaly_policy.OUTCOME_DEVICE_NOT_ACTIVE)
        if binding.bin_id != found.bin_id:
            return self._not_published(tx, found, anomaly_policy.OUTCOME_BINDING_MISMATCH)
        tx.lock_bin(found.bin_id)
        intervals = tx.intervals_covering(found.bin_id, found.observed_at)
        choice = select_lot(Reading(found.bin_id, binding.binding_version, found.observed_at), binding,
                            intervals, self.watermark())
        if isinstance(choice, NotReady):
            raise _Rollback(Result(NOT_READY, choice.reason))
        if not isinstance(choice, Selected):
            # Unreachable after the binding checks above; fail closed rather than guess a lot.
            raise _Rollback(Result(QUARANTINE, choice.reason if isinstance(choice, Reject) else "binding_conflict"))
        current = tx.intervals_covering(found.bin_id, self.clock())
        if current and current[0].occupancy_version != choice.interval.occupancy_version:
            # Preserve event-time history, but do not open a fresh advisory episode
            # for grain that is no longer in this bin. Threshold history is unchanged.
            return self._not_published(tx, found, anomaly_policy.OUTCOME_SUPERSEDED_LOT)
        return self._anomaly_score(tx, found, choice.interval)

    def _anomaly_score(self, tx: Tx, found: Anomaly, interval: Any) -> Result:
        policy = self.policies.get(interval.grain_type)
        if policy is None:
            raise _Rollback(Result(QUARANTINE, "policy_unavailable"))
        envelope = found.envelope
        existing = tx.assessment(envelope.event_id, interval.lot_id, policy.version)
        if existing is not None:
            return Result(DUPLICATE, event_id=str(existing[EVENT_ID]), assessment_id=str(existing[ASSESSMENT_ID]))
        if not tx.telemetry_received(envelope.causation_id, found.device_id, found.reading_id):
            if tx.telemetry_rejected(envelope.causation_id, found.device_id, found.reading_id):
                # Terminal rejection is not corroboration. Audit and release the
                # anomaly partition instead of waiting for an impossible receipt.
                return self._not_published(tx, found, anomaly_policy.OUTCOME_NO_CORROBORATION)
            # The anomaly and its triggering telemetry use different Kafka topics.
            # Wait for a committed threshold receipt before declaring corroboration
            # absent or scoring from an older state. Only this anomaly partition waits.
            raise _Rollback(Result(NOT_READY, "threshold_state_unavailable"))
        not_before = found.observed_at - timedelta(seconds=self.anomaly.corroboration_window_s)
        base_row = tx.latest_assessment(found.device_id, interval.lot_id, not_before, "threshold")
        base = None if base_row is None else int(base_row["score"])
        latest = tx.bin_published_score(interval.bin_id, interval.lot_id)
        decision = anomaly_policy.decide(self.anomaly, base, found.detector, policy.alert_score, latest)
        if decision.outcome != anomaly_policy.OUTCOME_PUBLISHED or decision.combined is None:
            return self._not_published(tx, found, decision.outcome, base, decision.points, decision.combined)
        reasons = _merged_reasons(base_row, anomaly_policy.METRIC_REASONS[found.metric])
        severity = "critical" if decision.combined >= anomaly_policy.CRITICAL_SCORE else "warning"
        event_id, assessment_id = deterministic_ids(envelope.tenant_id, envelope.event_id, interval.lot_id,
                                                    policy.version)
        values = {
            ASSESSMENT_ID: assessment_id, "source_event_id": envelope.event_id, "reading_id": found.reading_id,
            DEVICE_ID: found.device_id, "bin_id": interval.bin_id, "lot_id": interval.lot_id,
            "occupancy_version": interval.occupancy_version, "grain_type": interval.grain_type,
            "policy_version": policy.version, "score": decision.combined, "severity": severity,
            "alert_eligible": True, "reasons": list(reasons), "observed_at": found.observed_at,
            EVENT_ID: event_id, "aggregate_version": tx.next_stream_version(found.device_id),
            "correlation_id": envelope.correlation_id, "causation_id": envelope.event_id,
            "traceparent": envelope.traceparent, "source_kind": "anomaly",
        }
        tx.insert_assessment(values)
        tx.insert_outbox(build_event(envelope.tenant_id, values, self.clock()))
        tx.insert_anomaly_decision(_decision_values(found, anomaly_policy.OUTCOME_PUBLISHED, base,
                                                    decision.points, decision.combined, assessment_id))
        return Result(APPLIED, reason=anomaly_policy.OUTCOME_PUBLISHED, event_id=event_id,
                      assessment_id=assessment_id)

    @staticmethod
    def _not_published(tx: Tx, found: Anomaly, outcome: str, base: int | None = None,
                       points: int | None = None, combined: int | None = None) -> Result:
        """Record why an anomaly changed nothing. No outbox row: it cannot affect any alert."""
        tx.insert_anomaly_decision(_decision_values(found, outcome, base, points, combined, None))
        return Result(SKIPPED, outcome)


def _merged_reasons(base_row: Mapping[str, Any] | None, anomaly_reason: str) -> tuple[str, ...]:
    carried = [str(r) for r in (base_row["reasons"] if base_row else []) if r in _THRESHOLD_REASONS]
    return tuple(dict.fromkeys([*carried, anomaly_reason]))


def _decision_values(found: Anomaly, outcome: str, base: int | None, points: int | None,
                     combined: int | None, assessment_id: str | None) -> dict[str, Any]:
    return {"anomaly_event_id": found.envelope.event_id, DEVICE_ID: found.device_id, "metric": found.metric,
            "detector": found.detector, "outcome": outcome, "base_score": base, "points": points,
            "combined_score": combined, ASSESSMENT_ID: assessment_id, "observed_at": found.observed_at}


_THRESHOLD_REASONS = frozenset({"elevated_temperature", "elevated_humidity", "temperature_c",
                                "relative_humidity_percent"})


def build_event(tenant_id: str, values: Mapping[str, Any], occurred_at: datetime) -> dict[str, Any]:
    """The risk.assessed v1 envelope (contracts/events/risk-assessed.v1.schema.json)."""
    payload_keys = (ASSESSMENT_ID, DEVICE_ID, "reading_id", "source_event_id", "bin_id",
                    "lot_id", "grain_type", "score", "severity", "alert_eligible", "reasons")
    payload = {key: values[key] for key in payload_keys}
    payload.update(assessment_version=str(values["aggregate_version"]),
                   occupancy_version=str(values["occupancy_version"]),
                   policy_version=str(values["policy_version"]))
    return {
        EVENT_ID: values[EVENT_ID], "event_type": "risk.assessed", "schema_version": 1,
        "occurred_at": events.format_time(occurred_at), "tenant_id": tenant_id,
        "aggregate_type": "device_risk_stream", "aggregate_id": values[DEVICE_ID],
        "aggregate_version": str(values["aggregate_version"]),
        "correlation_id": values["correlation_id"], "causation_id": values["causation_id"],
        "traceparent": values["traceparent"], "payload": payload,
    }


def build_invalidation_event(change: LotChange, assessment: Mapping[str, Any], event_id: str,
                             version: int, occurred_at: datetime) -> dict[str, Any]:
    """Retract one prior assessment affected by a backdated lot replacement."""
    return {
        EVENT_ID: event_id, "event_type": "risk.assessment_invalidated", "schema_version": 1,
        "occurred_at": events.format_time(occurred_at), "tenant_id": change.envelope.tenant_id,
        "aggregate_type": "device_risk_stream", "aggregate_id": str(assessment[DEVICE_ID]),
        "aggregate_version": str(version), "correlation_id": change.envelope.correlation_id,
        "causation_id": change.envelope.event_id, "traceparent": change.envelope.traceparent,
        "payload": {
            ASSESSMENT_ID: str(assessment[ASSESSMENT_ID]),
            "assessment_version": str(version),
            DEVICE_ID: str(assessment[DEVICE_ID]), "reading_id": str(assessment["reading_id"]),
            "source_event_id": str(assessment["source_event_id"]),
            "bin_id": change.bin_id, "previous_lot_id": change.previous_lot_id,
            "replacement_lot_id": change.lot_id,
            "replacement_occupancy_version": str(change.occupancy_version),
            "observed_at": events.format_time(assessment["observed_at"]),
            "effective_from": events.format_time(change.effective_from),
            "reason": "backdated_lot_placement",
        },
    }


__all__ = ["Applier", "Record", "Result", "RetryPolicy", "TransientExhausted",
           "build_event", "deterministic_ids"]
