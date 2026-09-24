"""Consume loop: offsets advance only after a durable effect or a confirmed quarantine.

A NOT READY record pauses only its own partition (so lot and binding topics keep
flowing and can deliver the missing context), is retried with backoff, and after a
bounded wait is quarantined as ``lot_state_unavailable`` (or its binding variant)
and committed. Nothing is committed for a hard error; the process stops.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Mapping, Protocol

from risk_engine import events
from risk_engine.apply import NOT_READY, QUARANTINE, Applier, Record, Result
from risk_engine.events import Checkpoint, InvalidEvent
from risk_engine.health import Metrics

log = logging.getLogger("risk_engine")
UNAVAILABLE_REASONS = {"binding_state_unavailable": "binding_state_unavailable"}
DEFAULT_UNAVAILABLE = "lot_state_unavailable"
MAX_PENDING_CHECKPOINTS = 128


class Source(Protocol):
    def poll(self, timeout_s: float) -> Record | None: ...
    def commit(self, record: Record) -> None: ...
    def rewind_and_pause(self, record: Record) -> None: ...
    def resume(self, topic: str, partition: int) -> None: ...
    def high_watermarks(self, topic: str) -> Mapping[int, int]: ...
    def committed(self, topic: str) -> Mapping[int, int]: ...


class Sink(Protocol):
    def quarantine(self, record: Record, reason: str) -> None: ...


@dataclass
class _Waiting:
    record: Record
    first_at: float
    attempts: int
    resume_at: float
    reason: str


@dataclass
class LotFeed:
    """Tracks how far the lot topic is applied, from ADR-0009 source checkpoints.

    A checkpoint read from the device topic proves the transformer had already
    published every earlier lot change. We snapshot the lot topic's high watermarks at
    that moment; once our own applied offsets reach them, lot state is complete up to
    the checkpoint's source time. Kept in memory: after a restart the next heartbeat
    (every 30 s) re-establishes it and readings simply wait.
    """

    enabled: bool = True
    watermark: datetime | None = None
    applied: dict[int, int] = field(default_factory=dict)
    pending: list[tuple[datetime, Mapping[int, int]]] = field(default_factory=list)

    def value(self) -> datetime | None:
        return self.watermark if self.enabled else datetime.max.replace(tzinfo=timezone.utc)

    def observe(self, checkpoint: Checkpoint, targets: Mapping[int, int]) -> None:
        snapshot = dict(targets)
        # A later source time with identical targets supersedes the old checkpoint.
        same = [time for time, mark in self.pending if mark == snapshot]
        self.pending = [(time, mark) for time, mark in self.pending if mark != snapshot]
        self.pending.append((max([checkpoint.source_time, *same]), snapshot))
        # Dropping the oldest can delay watermark progress, never advance it falsely;
        # the next periodic checkpoint will provide a fresh bound.
        self.pending = self.pending[-MAX_PENDING_CHECKPOINTS:]

    def mark_applied(self, partition: int, next_offset: int) -> None:
        self.applied[partition] = max(self.applied.get(partition, 0), next_offset)

    def promote(self, committed: Callable[[], Mapping[int, int]]) -> None:
        if not self.pending:
            return
        base = committed()
        remaining = []
        for source_time, targets in self.pending:
            done = all(max(self.applied.get(p, 0), base.get(p, 0)) >= hw for p, hw in targets.items())
            if done:
                if self.watermark is None or source_time > self.watermark:
                    self.watermark = source_time
            else:
                remaining.append((source_time, targets))
        self.pending = remaining


def payload_digest(record: Record) -> str:
    return hashlib.sha256(record.value or b"").hexdigest()


class Consumer:
    def __init__(self, source: Source, sink: Sink, applier: Applier, lot_feed: LotFeed,
                 metrics: Metrics, max_wait_s: float = 300.0, backoff_s: float = 2.0,
                 monotonic: Callable[[], float] = time.monotonic):
        self.source, self.sink, self.applier, self.lot_feed = source, sink, applier, lot_feed
        self.metrics, self.max_wait_s, self.backoff_s, self.now = metrics, max_wait_s, backoff_s, monotonic
        self.waiting: dict[tuple[str, int], _Waiting] = {}
        self._next_promotion_at = float("-inf")

    def step(self, timeout_s: float = 1.0) -> Record | None:
        """Process at most one record; returns it (or None on an idle poll)."""
        self._resume_due()
        self._promote_due()
        record = self.source.poll(timeout_s)
        if record is not None:
            self.handle(record)
            if record.topic == events.LOT_TOPIC:
                self._promote_due()
        return record

    def _promote_due(self) -> None:
        if not self.lot_feed.pending or self.now() < self._next_promotion_at:
            return
        self._next_promotion_at = self.now() + 1.0
        self.lot_feed.promote(lambda: self.source.committed(events.LOT_TOPIC))

    def _resume_due(self) -> None:
        now = self.now()
        for (topic, partition), wait in self.waiting.items():
            if wait.resume_at <= now and wait.resume_at >= 0:
                wait.resume_at = -1
                self.source.resume(topic, partition)

    def handle(self, record: Record) -> None:
        try:
            event = events.parse(record.topic, record.value)
        except InvalidEvent as exc:
            self._quarantine(record, exc.reason)
            return
        if isinstance(event, Checkpoint):
            self.lot_feed.observe(event, self.source.high_watermarks(events.LOT_TOPIC))
            self._commit(record, "checkpoint")
            return
        result = self.applier.apply(record, event)
        if result.late_assessments:
            self.metrics.inc("risk_late_lot_changes_total")
            log.warning("backdated lot change affects %d earlier assessments", result.late_assessments)
        self._finish(record, result)

    def _finish(self, record: Record, result: Result) -> None:
        if result.outcome == NOT_READY:
            self._not_ready(record, result.reason or DEFAULT_UNAVAILABLE)
        elif result.outcome == QUARANTINE:
            self._quarantine(record, result.reason or "db_rejected")
        else:
            self._commit(record, result.outcome)

    def _not_ready(self, record: Record, reason: str) -> None:
        key = (record.topic, record.partition)
        now = self.now()
        wait = self.waiting.get(key)
        if wait is None or wait.record.offset != record.offset:
            wait = _Waiting(record, now, 0, now, reason)
            self.waiting[key] = wait
        wait.attempts += 1
        wait.reason = reason
        self.metrics.inc("risk_not_ready_total", reason=reason)
        if now - wait.first_at >= self.max_wait_s:
            self._quarantine(record, UNAVAILABLE_REASONS.get(reason, DEFAULT_UNAVAILABLE))
            return
        wait.resume_at = now + min(self.backoff_s * wait.attempts, 30.0)
        self.source.rewind_and_pause(record)

    def _quarantine(self, record: Record, reason: str) -> None:
        # The sink must confirm durably before the offset moves; a failure propagates.
        self.sink.quarantine(record, reason)
        self.metrics.inc("risk_quarantined_total", reason=reason)
        self._commit(record, QUARANTINE)

    def _commit(self, record: Record, outcome: str) -> None:
        self.source.commit(record)
        self.waiting.pop((record.topic, record.partition), None)
        if record.topic == events.LOT_TOPIC:
            self.lot_feed.mark_applied(record.partition, record.offset + 1)
        self.metrics.inc("risk_records_total", topic=record.topic, outcome=outcome)


class DatabaseSink:
    """Confirmed quarantine into the bounded quarantine_samples table."""

    def __init__(self, database: object, consumer_name: str):
        self.database, self.consumer_name = database, consumer_name

    def quarantine(self, record: Record, reason: str) -> None:
        self.database.quarantine(self.consumer_name, record.topic, record.partition, record.offset,  # type: ignore[attr-defined]
                                 reason, payload_digest(record))
