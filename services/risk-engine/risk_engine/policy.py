"""Immutable, tenant-owned grain policy versions and their validation rules."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

_GRAIN = re.compile(r"[a-z][a-z0-9_-]{0,31}\Z", re.ASCII)
_METRICS = {
    "temperature_c": ("Cel", -80.0, 120.0),
    "relative_humidity_percent": ("%", 0.0, 100.0),
    "co2_ppm": ("ppm", 0.0, None),
    "grain_moisture_percent": ("%", 0.0, 100.0),
}


@dataclass(frozen=True)
class PolicyVersion:
    tenant_id: str
    policy_id: str
    version: int
    grain_type: str
    bin_id: str | None
    effective_from: datetime
    effective_to: datetime | None
    measurement_thresholds: Mapping[str, Any]
    risk_thresholds: Mapping[str, int]
    calibrated: bool
    status: str
    provenance: Mapping[str, Any]
    calibration_evidence: str | None = None
    approved_by: str | None = None
    approved_at: datetime | None = None

    def as_dict(self) -> dict[str, Any]:
        def timestamp(value: datetime | None) -> str | None:
            return None if value is None else value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
        return {
            "policy_id": self.policy_id,
            "version": str(self.version),
            "grain_type": self.grain_type,
            "bin_id": self.bin_id,
            "effective_from": timestamp(self.effective_from),
            "effective_to": timestamp(self.effective_to),
            "measurement_thresholds": dict(self.measurement_thresholds),
            "risk_thresholds": dict(self.risk_thresholds),
            "calibrated": self.calibrated,
            "status": self.status,
            "provenance": dict(self.provenance),
            "calibration_evidence": self.calibration_evidence,
            "approved_by": self.approved_by,
            "approved_at": timestamp(self.approved_at),
        }


def validate_policy(policy: PolicyVersion) -> None:
    if not _GRAIN.fullmatch(policy.grain_type):
        raise ValueError("grain_type must be a lowercase grain identifier")
    if policy.version < 1:
        raise ValueError("policy version must be positive")
    if policy.effective_from.utcoffset() != timezone.utc.utcoffset(policy.effective_from):
        raise ValueError("effective_from must be UTC")
    if policy.effective_to is not None and policy.effective_to.utcoffset() != timezone.utc.utcoffset(policy.effective_to):
        raise ValueError("effective_to must be UTC")
    if policy.approved_at is not None and policy.approved_at.utcoffset() != timezone.utc.utcoffset(policy.approved_at):
        raise ValueError("approved_at must be UTC")
    if policy.status not in {"draft", "active"}:
        raise ValueError("policy status must be draft or active")
    if policy.effective_to is not None and policy.effective_to <= policy.effective_from:
        raise ValueError("effective_to must be after effective_from")
    if policy.status == "active" and not policy.calibrated:
        raise ValueError("uncalibrated policies cannot be active")
    if policy.calibrated and not (policy.calibration_evidence and policy.approved_by and policy.approved_at):
        raise ValueError("calibrated policies require evidence and approver provenance")
    for metric, thresholds in policy.measurement_thresholds.items():
        if metric not in _METRICS or not isinstance(thresholds, Mapping):
            raise ValueError("unsupported measurement threshold")
        unit, low, high = _METRICS[metric]
        if thresholds.get("unit") != unit:
            raise ValueError(f"{metric} requires unit {unit}")
        values = []
        for key in ("warning", "critical"):
            value = thresholds.get(key)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{metric}.{key} must be finite")
            if value < low or (high is not None and value > high):
                raise ValueError(f"{metric}.{key} is outside its physical range")
            values.append(float(value))
        if len(values) == 2 and values[0] >= values[1]:
            raise ValueError(f"{metric} warning must be below critical")
        if set(thresholds) - {"warning", "critical", "unit"}:
            raise ValueError(f"{metric} has unknown threshold fields")
    warning = policy.risk_thresholds.get("warning_score")
    critical = policy.risk_thresholds.get("critical_score")
    if set(policy.risk_thresholds) != {"warning_score", "critical_score"}:
        raise ValueError("risk thresholds must contain warning_score and critical_score only")
    for key, value in (("warning_score", warning), ("critical_score", critical)):
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 100:
            raise ValueError(f"{key} must be an integer in 1-100")
    if warning >= critical:
        raise ValueError("warning_score must be below critical_score")
    if warning > 75:
        raise ValueError("warning_score must be at most 75 so warning remains reachable")
    if policy.status == "active":
        for metric in ("temperature_c", "relative_humidity_percent"):
            thresholds = policy.measurement_thresholds.get(metric)
            if (not isinstance(thresholds, Mapping)
                    or not {"warning", "critical"} <= set(thresholds)
                    or thresholds.get("warning") is None
                    or thresholds.get("critical") is None):
                raise ValueError(f"active policies require finite warning and critical thresholds for {metric}")
    if not policy.provenance or not isinstance(policy.provenance, Mapping):
        raise ValueError("policy provenance is required")
