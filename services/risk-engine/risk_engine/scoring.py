"""Deterministic, illustrative grain-risk baseline; policy is not calibrated advice."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class Policy:
    grain_type: str
    version: int
    temperature_warn_c: float
    temperature_critical_c: float
    humidity_warn_percent: float
    humidity_critical_percent: float
    alert_score: int
    calibrated: bool = False
    policy_id: str | None = None
    provenance: str = "synthetic"
    critical_score: int = 75

    def __post_init__(self) -> None:
        if not self.grain_type or self.grain_type != self.grain_type.strip().lower():
            raise ValueError("policy requires a lowercase grain type")
        if self.version < 1:
            raise ValueError("policy version must be positive")
        values = (self.temperature_warn_c, self.temperature_critical_c,
                  self.humidity_warn_percent, self.humidity_critical_percent)
        if not all(math.isfinite(v) for v in values):
            raise ValueError("policy thresholds must be finite")
        if self.temperature_warn_c >= self.temperature_critical_c:
            raise ValueError("temperature thresholds must increase")
        if not (0 <= self.humidity_warn_percent < self.humidity_critical_percent <= 100):
            raise ValueError("humidity thresholds must increase within 0-100")
        if not 1 <= self.alert_score <= 75:
            raise ValueError("alert score must be within 1-75")


@dataclass(frozen=True)
class Assessment:
    grain_type: str
    policy_version: int
    score: int | None
    severity: str
    reasons: tuple[str, ...]
    alert_eligible: bool
    policy_status: str = "active"


def _measurement(measurements: Mapping[str, object], key: str, low: float, high: float) -> float | None:
    raw = measurements.get(key)
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError(f"{key} must be numeric")
    try:
        value = float(raw)
    except OverflowError as exc:
        raise ValueError(f"{key} outside accepted range") from exc
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{key} outside accepted range")
    return value


def assess(measurements: Mapping[str, object], grain_type: str, policy: Policy) -> Assessment:
    """Score only accepted grain telemetry; absent inputs are never read as zero."""
    if grain_type != policy.grain_type:
        raise ValueError("grain type does not match selected policy")
    if set(measurements) - {"temperature_c", "relative_humidity_percent", "co2_ppm",
                            "grain_moisture_percent"}:
        raise ValueError("unsupported measurement")
    if not policy.calibrated:
        # Synthetic/unapproved limits are provenance only; they must never generate
        # an operational score or alert.
        return Assessment(grain_type, policy.version, None, "insufficient_data",
                          ("policy_not_calibrated",), False, "not_calibrated")
    temperature = _measurement(measurements, "temperature_c", -80, 120)
    humidity = _measurement(measurements, "relative_humidity_percent", 0, 100)
    if temperature is None or humidity is None:
        missing = tuple(k for k, v in (("temperature_c", temperature),
                                        ("relative_humidity_percent", humidity)) if v is None)
        return Assessment(grain_type, policy.version, None, "insufficient_data", missing, False)

    # A fixed integer scale makes replay independent of statistical-model state.
    def points(value: float, warning: float, critical: float) -> int:
        if value < warning:
            return 0
        if value >= critical:
            return 50
        return 25

    temperature_points = points(temperature, policy.temperature_warn_c, policy.temperature_critical_c)
    humidity_points = points(humidity, policy.humidity_warn_percent, policy.humidity_critical_percent)
    score = temperature_points + humidity_points
    reasons = tuple(reason for condition, reason in (
        (temperature_points > 0, "elevated_temperature"),
        (humidity_points > 0, "elevated_humidity"),
    ) if condition)
    if score >= policy.critical_score:
        severity = "critical"
    elif score >= policy.alert_score:
        severity = "warning"
    else:
        severity = "normal"
    return Assessment(grain_type, policy.version, score, severity, reasons, score >= policy.alert_score)
