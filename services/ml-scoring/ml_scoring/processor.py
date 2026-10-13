"""Transactional synthetic-tenant shadow scoring for canonical telemetry events."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import time
import uuid
from typing import Any, Iterator

import numpy as np

from ml_scoring.contracts import ContractError, TelemetryEvent, parse_telemetry_recorded
from ml_scoring.events import build_shadow_prediction_event
from ml_scoring.registry import LoadedModel
from ml_scoring.store import (INBOX_PRUNE_BATCH_SIZE, SHADOW_RETENTION_BATCH_SIZE,
                              Repository, ShadowPrediction)


INPUT_TOPIC = "greenguard.telemetry.recorded.v1"
FEATURE_SET_VERSION = "telemetry-sequence-v1-24h-15m"
CONTEXT_STEPS = 96
CADENCE = timedelta(minutes=15)
MIN_HISTORY_STEPS = 24  # cold-start floor from I5 D5.9: six hours
MAX_LATENESS_STEPS = 4  # retain one hour of cross-sensor delivery reordering
MAX_HISTORY_PER_DEVICE = 128
if MAX_HISTORY_PER_DEVICE < CONTEXT_STEPS + MAX_LATENESS_STEPS:
    raise RuntimeError("per-device history limit cannot cover context plus maximum lateness")
_PREDICTION_NAMESPACE = uuid.UUID("a874394e-2019-5a66-9bd7-f485188e88c0")


@dataclass(frozen=True)
class ProcessResult:
    status: str
    prediction_id: str | None = None
    probability: float | None = None
    model_version: str | None = None
    inference_ms: float | None = None


def _timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _wire_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _grid_floor(value: datetime) -> datetime:
    seconds = int(value.timestamp())
    return datetime.fromtimestamp(seconds - seconds % int(CADENCE.total_seconds()), timezone.utc)


def _reading_json(event: TelemetryEvent) -> dict[str, object]:
    return {
        "event_id": event.event_id, "sequence": event.sequence,
        "slot": _wire_time(_grid_floor(event.observed_at)),
        "observed_at": _wire_time(event.observed_at), "received_at": _wire_time(event.received_at),
        "temperature_c": event.temperature_c,
        "relative_humidity_percent": event.relative_humidity_percent,
    }


def _sequence(state: dict, *, window_end: datetime, as_of: datetime) -> tuple[np.ndarray, int, int]:
    """Build fixed cadence as-seen input; reports usable history and current sensors."""
    devices = state.get("devices")
    if not isinstance(devices, dict) or not devices:
        return np.zeros((1, CONTEXT_STEPS, 0), dtype=np.float32), 0, 0
    grid_start = window_end - (CONTEXT_STEPS - 1) * CADENCE
    timestamps = [grid_start + index * CADENCE for index in range(CONTEXT_STEPS)]
    channels: list[np.ndarray] = []
    present_at_end = 0
    usable_sensors = 0
    for device_id in sorted(devices):
        rows = devices[device_id]
        by_observed = {_timestamp(row.get("slot", row["observed_at"])): row for row in rows}
        valid_history = [row for row in rows if _timestamp(row["received_at"]) <= as_of
                         and grid_start <= _timestamp(row.get("slot", row["observed_at"])) <= window_end
                         and row.get("temperature_c") is not None
                         and row.get("relative_humidity_percent") is not None]
        if len(valid_history) >= MIN_HISTORY_STEPS:
            usable_sensors += 1
        latest = by_observed.get(window_end)
        if (latest is not None and _timestamp(latest["received_at"]) <= as_of
                and latest.get("temperature_c") is not None
                and latest.get("relative_humidity_percent") is not None):
            present_at_end += 1
        rows_by_feature = np.zeros((CONTEXT_STEPS, 3), dtype=np.float32)
        for index, timestamp in enumerate(timestamps):
            reading = by_observed.get(timestamp)
            if reading is None or _timestamp(reading["received_at"]) > as_of:
                rows_by_feature[index, 2] = 1.0
                continue
            temperature, humidity = reading.get("temperature_c"), reading.get("relative_humidity_percent")
            if temperature is None or humidity is None:
                rows_by_feature[index, 2] = 1.0
                continue
            rows_by_feature[index] = (float(temperature), float(humidity), 0.0)
        channels.append(rows_by_feature)
    if not channels:
        return np.zeros((1, CONTEXT_STEPS, 0), dtype=np.float32), usable_sensors, present_at_end
    values = np.stack(channels, axis=1).reshape(1, CONTEXT_STEPS, len(channels) * 3)
    return values, usable_sensors, present_at_end


class CorruptBinWindowState(ValueError):
    """Persisted sequence state is malformed and cannot be scored safely."""


class ScoringInputError(ValueError):
    """The sequence or model output violates the scorer contract."""


class BinDeviceLimitExceeded(RuntimeError):
    """A bin exceeded its configured number of sensor devices."""


class ShadowScoringProcessor:
    """Fail-closed processor used only for an explicitly allowlisted synthetic tenant."""

    def __init__(self, model: LoadedModel, repository: Repository, *, synthetic_tenant_id: str,
                 expected_sensor_count: int = 16):
        if not model.manifest.synthetic_only or model.manifest.production_eligible:
            raise ValueError("local scoring prototype accepts synthetic-only, production-ineligible models")
        if not synthetic_tenant_id:
            raise ValueError("an explicit synthetic tenant UUID allowlist entry is required")
        if expected_sensor_count < 1 or expected_sensor_count > 64:
            raise ValueError("expected_sensor_count must be from 1 through 64")
        self.model, self.repository = model, repository
        self.synthetic_tenant_id = synthetic_tenant_id
        self.expected_sensor_count = expected_sensor_count
        self._next_inbox_prune_at: datetime | None = None
        self._next_shadow_prune_at: datetime | None = None

    @contextmanager
    def _tenant_transaction(self, tenant_id: str) -> Iterator[Any]:
        prune_deadline: datetime | None = None
        shadow_prune_deadline: datetime | None = None
        with self.repository.tenant_transaction(tenant_id) as transaction:
            now = datetime.now(timezone.utc)
            if self._next_inbox_prune_at is None or now >= self._next_inbox_prune_at:
                deleted = transaction.prune_inbox(now - timedelta(days=30))
                # Drain a backlog gradually, while bounding the work in every
                # scoring transaction and keeping the normal idle cadence hourly.
                interval = timedelta(minutes=1) if deleted >= INBOX_PRUNE_BATCH_SIZE else timedelta(hours=1)
                prune_deadline = now + interval
            if self._next_shadow_prune_at is None or now >= self._next_shadow_prune_at:
                deleted = transaction.prune_published_shadow_rows(now - timedelta(days=30))
                interval = (timedelta(minutes=1) if deleted >= SHADOW_RETENTION_BATCH_SIZE
                            else timedelta(hours=1))
                shadow_prune_deadline = now + interval
            yield transaction
        # The repository context has committed successfully. A rollback/exception
        # leaves pruning eligible on the next tenant event.
        if prune_deadline is not None:
            self._next_inbox_prune_at = prune_deadline
        if shadow_prune_deadline is not None:
            self._next_shadow_prune_at = shadow_prune_deadline

    def process(self, topic: str, key: bytes | str | None, raw: bytes | str | None, *,
                partition: int, offset: int) -> ProcessResult:
        if raw is None:
            digest = hashlib.sha256(b"").hexdigest()
            self.repository.quarantine(topic=topic, partition=partition, offset=offset,
                                       reason="contract:null_value", digest=digest)
            return ProcessResult("quarantined")
        digest = hashlib.sha256(raw if isinstance(raw, bytes) else raw.encode()).hexdigest()
        if topic != INPUT_TOPIC:
            self.repository.quarantine(topic=topic, partition=partition, offset=offset,
                                       reason="unsupported_topic", digest=digest)
            return ProcessResult("quarantined")
        try:
            event = parse_telemetry_recorded(key, raw)
        except ContractError as exc:
            self.repository.quarantine(topic=topic, partition=partition, offset=offset,
                                       reason=f"contract:{type(exc).__name__}", digest=digest)
            return ProcessResult("quarantined")
        if event.tenant_id != self.synthetic_tenant_id:
            self.repository.quarantine(topic=topic, partition=partition, offset=offset,
                                       reason="tenant_not_in_synthetic_allowlist", digest=event.digest)
            return ProcessResult("tenant_rejected")
        with self._tenant_transaction(event.tenant_id) as transaction:
            if not transaction.claim_event(event, topic=topic, partition=partition, offset=offset):
                return ProcessResult("duplicate")
            if event.bin_id is None:
                return ProcessResult("unbound_bin")
            state = transaction.load_bin_state(event.bin_id)
            try:
                devices = state.setdefault("devices", {})
                window_end = _grid_floor(event.observed_at)
                prior_end_raw = state.get("prune_window_end")
                prior_end = _timestamp(prior_end_raw) if isinstance(prior_end_raw, str) else window_end
                prune_end = max(window_end, prior_end)
                grid_start = prune_end - (CONTEXT_STEPS - 1 + MAX_LATENESS_STEPS) * CADENCE
                if window_end < grid_start:
                    return ProcessResult("late_event_outside_window")
                for stale_device in list(devices):
                    retained = [row for row in devices[stale_device]
                                if _timestamp(row["observed_at"]) >= grid_start]
                    if retained:
                        devices[stale_device] = retained
                    else:
                        del devices[stale_device]
                state["prune_window_end"] = _wire_time(prune_end)
                if event.device_id not in devices and len(devices) >= self.expected_sensor_count:
                    raise BinDeviceLimitExceeded("bin has more devices than its configured sensor count")
                history = devices.setdefault(event.device_id, [])
                if history:
                    device_latest = max(_timestamp(row.get("slot", row["observed_at"])) for row in history)
                    if window_end < device_latest - MAX_LATENESS_STEPS * CADENCE:
                        return ProcessResult("late_event_outside_window")
                reading = _reading_json(event)
                prior = next((row for row in history
                              if row.get("slot", row["observed_at"]) == reading["slot"]), None)
                if prior is None:
                    history.append(reading)
                elif (event.sequence, reading["observed_at"]) > (int(prior["sequence"]), prior["observed_at"]):
                    history.remove(prior)
                    history.append(reading)
                history.sort(key=lambda row: (row["observed_at"], int(row["sequence"])))
                devices[event.device_id] = history[-MAX_HISTORY_PER_DEVICE:]
            except BinDeviceLimitExceeded:
                raise
            except (AttributeError, KeyError, TypeError, ValueError, OverflowError) as exc:
                raise CorruptBinWindowState("stored bin sequence state is invalid") from exc
            transaction.save_bin_state(event.bin_id, state, event.sequence)

            # Score once, after every expected reference-bin sensor has delivered
            # the current cadence point. Missing/stale state remains visible as a
            # no-prediction status and never invents a positive advisory.
            try:
                slot_key = _wire_time(window_end)
                as_of = max(
                    [event.received_at] + [
                        _timestamp(row["received_at"])
                        for rows in state.get("devices", {}).values() for row in rows
                        if row.get("slot", row["observed_at"]) == slot_key
                    ]
                )
                values, usable_sensors, current_sensors = _sequence(
                    state, window_end=window_end, as_of=as_of,
                )
            except (AttributeError, KeyError, TypeError, ValueError, OverflowError) as exc:
                raise CorruptBinWindowState("stored bin sequence state is invalid") from exc
            if current_sensors < self.expected_sensor_count:
                return ProcessResult("awaiting_bin_grid")
            if usable_sensors < self.expected_sensor_count:
                return ProcessResult("insufficient_history")
            if values.shape[2] % 3 or not np.isfinite(values).all():
                raise ScoringInputError("sequence builder violated model input contract")
            inference_started = time.perf_counter()
            probability = float(self.model.predict(values)[0])
            inference_ms = (time.perf_counter() - inference_started) * 1000
            if not math.isfinite(probability) or not 0.0 <= probability <= 1.0:
                raise ScoringInputError("model emitted an invalid probability")
            feature_digest = hashlib.sha256(values.tobytes(order="C")).hexdigest()
            model = self.model.manifest
            identity = (f"{event.tenant_id}:{event.bin_id}:{_wire_time(window_end)}:"
                        f"{model.model_name}:{model.model_version}:{FEATURE_SET_VERSION}:0")
            prediction_id = str(uuid.uuid5(_PREDICTION_NAMESPACE, identity))
            prediction = ShadowPrediction(
                prediction_id=prediction_id, tenant_id=event.tenant_id, subject_id=event.bin_id,
                window_end=_wire_time(window_end), model_name=model.model_name,
                model_version=model.model_version, feature_set_version=FEATURE_SET_VERSION,
                revision=0, probability=probability, feature_digest=feature_digest,
                correlation_id=event.correlation_id, causation_id=event.event_id,
                traceparent=event.traceparent,
            )
            shadow_event = build_shadow_prediction_event(prediction, event, datetime.now(timezone.utc))
            inserted = transaction.write_shadow_prediction(prediction, shadow_event)
            if not inserted:
                return ProcessResult("shadow_prediction_exists", prediction_id, None, model.model_version)
            return ProcessResult("shadow_scored", prediction_id, probability,
                                 model.model_version, inference_ms)
