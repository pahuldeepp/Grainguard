"""Non-actionable rendering of synthetic ML shadow comparisons."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import NewType

from risk_engine.scoring import Assessment

TenantId = NewType("TenantId", str)
BinId = NewType("BinId", str)


@dataclass(frozen=True)
class RiskAssessment:
    tenant_id: TenantId
    bin_id: BinId
    assessment: Assessment
    source_event_id: str


@dataclass(frozen=True)
class Preview:
    severity: str
    deterministic_score: int | None
    label: str
    shadow_context: str
    bin_id: str
    source_event_id: str

    def render(self) -> str:
        score = "unavailable" if self.deterministic_score is None else str(self.deterministic_score)
        return (
            f"{self.label}\n"
            f"Bin {self.bin_id}: deterministic baseline {score}/100; "
            f"severity {self.severity}.\n"
            f"{self.shadow_context}\n"
            "No alert, risk state, or operational action is created by this preview."
        )


def build_preview(risk: RiskAssessment, *, shadow_event: dict[str, object],
                  now: datetime, max_age: timedelta) -> Preview:
    """Build an auditable advisory preview without changing operational state."""
    if now.tzinfo is None or now.utcoffset() is None or max_age <= timedelta(0):
        raise ValueError("preview time and age bound must be valid")
    if not isinstance(shadow_event, dict):
        raise ValueError("shadow event must be an object")
    payload = shadow_event.get("payload")
    if (shadow_event.get("event_type") != "ml.prediction.shadowed"
            or shadow_event.get("tenant_id") != str(risk.tenant_id)
            or not isinstance(payload, dict)
            or payload.get("subject_id") != str(risk.bin_id)
            or payload.get("source_event_id") != risk.source_event_id
            or payload.get("mode") != "shadow"
            or payload.get("data_origin") != "synthetic_grain_sim"
            or payload.get("production_eligible") is not False):
        raise ValueError("preview requires a matching synthetic shadow event")
    occurred_at = shadow_event.get("occurred_at")
    if not isinstance(occurred_at, str):
        raise ValueError("shadow event timestamp is required")
    try:
        timestamp = datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("shadow event timestamp is invalid") from exc
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise ValueError("shadow event timestamp must include a timezone")
    age = now.astimezone(timestamp.tzinfo) - timestamp
    if age < -timedelta(minutes=5) or age > max_age:
        raise ValueError("shadow event is outside the preview freshness window")
    assessment = risk.assessment
    if (assessment.score is not None
            and (isinstance(assessment.score, bool) or not 0 <= assessment.score <= 100)):
        raise ValueError("risk baseline score is outside 0-100")
    if not isinstance(assessment.severity, str) or not assessment.severity:
        raise ValueError("risk baseline severity is missing")
    return Preview(
        severity=assessment.severity,
        deterministic_score=assessment.score,
        label="INFORMATIONAL · NON-ACTIONABLE · SYNTHETIC-ONLY",
        shadow_context=(
            "Synthetic model output is shown for comparison only and does not alter "
            "the deterministic risk baseline, alert lifecycle, or operating controls."
        ),
        bin_id=str(risk.bin_id),
        source_event_id=risk.source_event_id,
    )
