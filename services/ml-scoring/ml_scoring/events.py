"""Canonical shadow-only prediction event construction."""

from __future__ import annotations

from datetime import datetime, timezone
import uuid

from ml_scoring.contracts import TelemetryEvent
from ml_scoring.store import ShadowPrediction


SHADOW_PREDICTION_TOPIC = "greenguard.ml.prediction.shadow.v1"
_SHADOW_EVENT_NAMESPACE = uuid.UUID("93c5f247-6085-4e2d-b1ef-4d2c647ce634")


def _utc(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("shadow event timestamps must be timezone-aware")
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def build_shadow_prediction_event(prediction: ShadowPrediction, source: TelemetryEvent,
                                  occurred_at: datetime) -> dict[str, object]:
    """Build a versioned event that cannot be mistaken for a risk assessment."""
    if prediction.tenant_id != source.tenant_id:
        raise ValueError("shadow prediction tenant must match its source event")
    if prediction.status != "shadow" or prediction.data_origin != "synthetic_grain_sim":
        raise ValueError("only synthetic shadow predictions can be published on this topic")
    payload = {
        "prediction_id": prediction.prediction_id,
        "source_event_id": source.event_id,
        "subject_type": "bin",
        "subject_id": prediction.subject_id,
        "window_end": prediction.window_end,
        "model_name": prediction.model_name,
        "model_version": prediction.model_version,
        "feature_set_version": prediction.feature_set_version,
        "revision": prediction.revision,
        "probability": prediction.probability,
        "target": "simulated_hotspot_onset_48h",
        "target_semantics": "a simulated hotspot false-to-true transition occurs within the next 48 hours; an already-active hotspot is negative",
        "feature_digest": prediction.feature_digest,
        "mode": "shadow",
        "data_origin": prediction.data_origin,
        "production_eligible": False,
    }
    event_id = str(uuid.uuid5(_SHADOW_EVENT_NAMESPACE, prediction.prediction_id))
    return {
        "event_id": event_id,
        "event_type": "ml.prediction.shadowed",
        "schema_version": 1,
        "occurred_at": _utc(occurred_at),
        "tenant_id": prediction.tenant_id,
        "aggregate_type": "ml_prediction",
        "aggregate_id": prediction.prediction_id,
        "aggregate_version": "1",
        "correlation_id": source.correlation_id,
        "causation_id": source.event_id,
        "traceparent": source.traceparent,
        "payload": payload,
    }
