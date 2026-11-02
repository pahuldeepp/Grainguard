"""Advisory anomaly policy (ADR-0031).

An anomaly from the optional Flink job can only add risk on top of what the threshold
path already decided; it never lowers, replaces or suppresses it. The score arithmetic
is deliberately small so it can be replayed and explained.

    base      = score of the device's latest threshold assessment for the same lot
    combined  = max(base, min(cap, base + points))
    published = maximum latest non-invalidated publication for this lot among
                devices actively bound to this bin, ordered by device stream version
    publish   = combined > max(base, published) and combined >= alert_score

``cap`` stays below 75, so an anomaly alone can never reach the critical band, and a
published assessment exceeds that bin-wide guard. The alert consumer also guards
against cross-device reordering before applying an advisory to an active episode.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

OUTCOME_PUBLISHED = "published"
OUTCOME_NO_CORROBORATION = "no_corroboration"
OUTCOME_NOT_HIGHER = "not_higher"
OUTCOME_BELOW_THRESHOLD = "below_threshold"
OUTCOME_TOO_OLD = "too_old"
OUTCOME_DEVICE_UNBOUND = "device_unbound"
OUTCOME_DEVICE_NOT_ACTIVE = "device_not_active"
OUTCOME_BINDING_MISMATCH = "binding_mismatch"
OUTCOME_SUPERSEDED_LOT = "superseded_lot"
OUTCOMES = (OUTCOME_PUBLISHED, OUTCOME_NO_CORROBORATION, OUTCOME_NOT_HIGHER, OUTCOME_BELOW_THRESHOLD,
            OUTCOME_TOO_OLD, OUTCOME_DEVICE_UNBOUND, OUTCOME_DEVICE_NOT_ACTIVE, OUTCOME_BINDING_MISMATCH,
            OUTCOME_SUPERSEDED_LOT)

METRIC_REASONS = {"temperature_c": "anomalous_temperature", "relative_humidity_percent": "anomalous_humidity"}
DETECTORS = ("zscore", "rapid_change")
CRITICAL_SCORE = 75
_MAX_WINDOW_S = 7 * 86400


@dataclass(frozen=True)
class AnomalyPolicy:
    zscore_points: int = 25
    rapid_points: int = 25
    cap: int = 74
    corroboration_window_s: int = 3600
    max_age_s: int = 3600

    def __post_init__(self) -> None:
        for name in ("zscore_points", "rapid_points"):
            if not 1 <= getattr(self, name) <= 75:
                raise ValueError(f"{name} must be within 1-75")
        if not 1 <= self.cap < CRITICAL_SCORE:
            raise ValueError("cap must be below 75: an anomaly alone never reaches critical")
        for name in ("corroboration_window_s", "max_age_s"):
            if not 1 <= getattr(self, name) <= _MAX_WINDOW_S:
                raise ValueError(f"{name} must be within 1 second and 7 days")

    def points(self, detector: str) -> int:
        if detector not in DETECTORS:
            raise ValueError("unknown detector")
        return self.zscore_points if detector == "zscore" else self.rapid_points


@dataclass(frozen=True)
class Decision:
    outcome: str
    points: int
    combined: int | None


def decide(policy: AnomalyPolicy, base_score: int | None, detector: str, alert_score: int,
           published_score: int | None = None) -> Decision:
    points = policy.points(detector)
    if base_score is None:
        return Decision(OUTCOME_NO_CORROBORATION, points, None)
    combined = max(base_score, min(policy.cap, base_score + points))
    if combined <= max(base_score, published_score or 0):
        return Decision(OUTCOME_NOT_HIGHER, points, combined)
    if combined < alert_score:
        return Decision(OUTCOME_BELOW_THRESHOLD, points, combined)
    return Decision(OUTCOME_PUBLISHED, points, combined)


def from_env(getenv: Callable[[str], str | None]) -> AnomalyPolicy:
    """Read RISK_ANOMALY_* settings; any invalid value stops startup."""
    defaults = AnomalyPolicy()

    def number(name: str, default: int) -> int:
        raw = getenv(name)
        if raw is None or not raw.strip():
            return default
        try:
            return int(raw)
        except ValueError:
            raise ValueError(f"{name} must be an integer") from None

    return AnomalyPolicy(
        zscore_points=number("RISK_ANOMALY_ZSCORE_POINTS", defaults.zscore_points),
        rapid_points=number("RISK_ANOMALY_RAPID_POINTS", defaults.rapid_points),
        cap=number("RISK_ANOMALY_CAP", defaults.cap),
        corroboration_window_s=number("RISK_ANOMALY_CORROBORATION_WINDOW_S", defaults.corroboration_window_s),
        max_age_s=number("RISK_ANOMALY_MAX_AGE_S", defaults.max_age_s))
