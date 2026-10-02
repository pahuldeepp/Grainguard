"""Deterministic features over the current canonical telemetry measurements.

This first slice deliberately handles a single tenant/device stream. Filtering
by both observed and received time implements event-time and knowledge-time
as-of semantics; sorting makes results independent of delivery order.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
from typing import Iterable, Mapping

FEATURE_SET_VERSION = "telemetry-v1.0"
_HOUR = timedelta(hours=1)
_DAY = timedelta(hours=24)


@dataclass(frozen=True, slots=True)
class TelemetryReading:
    tenant_id: str
    device_id: str
    event_id: str
    observed_at: datetime
    received_at: datetime
    measurements: Mapping[str, float | None]


@dataclass(frozen=True, slots=True)
class FeatureKey:
    """Identity for a feature row; tenant identity is never discarded."""

    tenant_id: str
    entity_type: str
    entity_id: str
    as_of: datetime
    feature_set_version: str = FEATURE_SET_VERSION
    revision: int = 1


@dataclass(frozen=True, slots=True)
class FeatureVector:
    key: FeatureKey
    values: Mapping[str, float | int | bool | None]


def _require_utc(value: datetime, field: str) -> None:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be timezone-aware UTC")


def _valid_measurement(value: float | None) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("measurement must be a number or None")
    numeric = float(value)
    if not math.isfinite(numeric):
        return None
    return numeric


def _window_values(
    rows: list[TelemetryReading], metric: str, start: datetime, end: datetime
) -> list[float]:
    values: list[float] = []
    for row in rows:
        if start < row.observed_at <= end:
            value = _valid_measurement(row.measurements.get(metric))
            if value is not None:
                values.append(value)
    return values


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def compute_features(
    readings: Iterable[TelemetryReading],
    *,
    as_of: datetime,
    expected_cadence: timedelta = timedelta(minutes=15),
) -> FeatureVector:
    """Build a point-in-time feature vector for one tenant and device.

    A row is eligible only when both `observed_at <= as_of` and
    `received_at <= as_of`. This prevents future event leakage and excludes
    late data that was not yet knowable at the requested serving time.
    The caller should supply the full retained input window needed by the
    feature set; this kernel does not fetch or retain state.
    """

    _require_utc(as_of, "as_of")
    if expected_cadence <= timedelta(0):
        raise ValueError("expected_cadence must be positive")

    materialized = list(readings)
    if not materialized:
        raise ValueError("at least one reading is required to establish tenant/device key")

    tenant_ids = {row.tenant_id for row in materialized}
    device_ids = {row.device_id for row in materialized}
    if len(tenant_ids) != 1 or len(device_ids) != 1:
        raise ValueError("compute_features accepts exactly one tenant/device stream")
    if any(not row.tenant_id or not row.device_id or not row.event_id for row in materialized):
        raise ValueError("tenant_id, device_id, and event_id must be non-empty")

    for row in materialized:
        _require_utc(row.observed_at, "observed_at")
        _require_utc(row.received_at, "received_at")

    eligible = [
        row
        for row in materialized
        if row.observed_at <= as_of and row.received_at <= as_of
    ]
    eligible.sort(key=lambda row: (row.observed_at, row.received_at, row.event_id))
    latest = eligible[-1] if eligible else None
    start_1h = as_of - _HOUR
    start_24h = as_of - _DAY
    expected_24h = max(1, math.ceil(_DAY / expected_cadence))

    values: dict[str, float | int | bool | None] = {
        "reading_count_1h": 0,
        "reading_count_24h": 0,
        "latest_reading_age_minutes": None,
        "temperature_c": None,
        "temperature_c_missing": True,
        "relative_humidity_percent": None,
        "relative_humidity_percent_missing": True,
        "temperature_c_mean_1h": None,
        "temperature_c_mean_24h": None,
        "temperature_c_delta_1h": None,
        "temperature_c_delta_24h": None,
        "relative_humidity_percent_mean_1h": None,
        "relative_humidity_percent_mean_24h": None,
        "relative_humidity_percent_delta_1h": None,
        "relative_humidity_percent_delta_24h": None,
        "max_gap_minutes_24h": None,
        "coverage_24h": 0.0,
        "lateness_minutes_mean_24h": None,
    }
    recent = [row for row in eligible if start_24h < row.observed_at <= as_of]
    values["reading_count_1h"] = sum(row.observed_at > start_1h for row in recent)
    values["reading_count_24h"] = len(recent)
    values["coverage_24h"] = min(1.0, len(recent) / expected_24h)

    if latest is not None:
        values["latest_reading_age_minutes"] = (
            as_of - latest.observed_at
        ).total_seconds() / 60
        for metric in ("temperature_c", "relative_humidity_percent"):
            value = _valid_measurement(latest.measurements.get(metric))
            values[metric] = value
            values[f"{metric}_missing"] = value is None

    for metric in ("temperature_c", "relative_humidity_percent"):
        one_hour = _window_values(eligible, metric, start_1h, as_of)
        one_day = _window_values(eligible, metric, start_24h, as_of)
        mean_1h = _mean(one_hour)
        mean_24h = _mean(one_day)
        values[f"{metric}_mean_1h"] = mean_1h
        values[f"{metric}_mean_24h"] = mean_24h
        values[f"{metric}_delta_1h"] = (
            one_hour[-1] - one_hour[0] if len(one_hour) >= 2 else None
        )
        values[f"{metric}_delta_24h"] = (
            one_day[-1] - one_day[0] if len(one_day) >= 2 else None
        )

    timestamps = sorted({row.observed_at for row in recent})
    if len(timestamps) >= 2:
        values["max_gap_minutes_24h"] = max(
            (right - left).total_seconds() / 60
            for left, right in zip(timestamps, timestamps[1:])
        )
    if recent:
        values["lateness_minutes_mean_24h"] = sum(
            (row.received_at - row.observed_at).total_seconds() / 60 for row in recent
        ) / len(recent)

    tenant_id = next(iter(tenant_ids))
    device_id = next(iter(device_ids))
    return FeatureVector(
        key=FeatureKey(
            tenant_id=tenant_id,
            entity_type="device",
            entity_id=device_id,
            as_of=as_of.astimezone(timezone.utc),
        ),
        values=values,
    )
