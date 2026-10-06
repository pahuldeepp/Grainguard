"""Strict parser for the ML scorer's isolated, synthetic shadow topic.

Shadow predictions are comparison evidence only. This module deliberately has
no database, alert, or product-risk write path.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
import uuid


@dataclass(frozen=True)
class ShadowPrediction:
    tenant_id: str
    subject_id: str
    source_event_id: str
    prediction_id: str
    probability: float


def _uuid(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a canonical UUID")
    try:
        parsed = str(uuid.UUID(value))
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"{field} must be a canonical UUID") from exc
    if parsed != value:
        raise ValueError(f"{field} must be a canonical lowercase UUID")
    return parsed


def parse_shadow_prediction(raw: bytes, *, expected_tenant_id: str,
                            kafka_key: bytes) -> ShadowPrediction:
    """Validate the complete identity and non-promotion contract of v1 events."""
    expected_tenant = _uuid(expected_tenant_id, "expected_tenant_id")
    try:
        event = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as exc:
        raise ValueError("shadow event must be valid UTF-8 JSON") from exc
    if not isinstance(event, dict):
        raise ValueError("shadow event must be an object")
    if (type(event.get("schema_version")) is not int or event.get("schema_version") != 1 or event.get("event_type") != "ml.prediction.shadowed"
            or event.get("aggregate_type") != "ml_prediction"):
        raise ValueError("unsupported shadow prediction envelope")
    tenant = _uuid(event.get("tenant_id"), "tenant_id")
    event_id = _uuid(event.get("event_id"), "event_id")
    prediction_id = _uuid(event.get("aggregate_id"), "aggregate_id")
    if tenant != expected_tenant:
        raise ValueError("shadow prediction belongs to another tenant")
    payload = event.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("shadow prediction payload must be an object")
    if (payload.get("prediction_id") != prediction_id
            or payload.get("mode") != "shadow"
            or payload.get("production_eligible") is not False
            or payload.get("data_origin") != "synthetic_grain_sim"
            or payload.get("target") != "simulated_hotspot_onset_48h"
            or payload.get("subject_type") != "bin"):
        raise ValueError("shadow prediction is outside the synthetic-only contract")
    source_event_id = _uuid(payload.get("source_event_id"), "source_event_id")
    if event.get("causation_id") != source_event_id:
        raise ValueError("shadow prediction causation does not match its source")
    subject_id = _uuid(payload.get("subject_id"), "subject_id")
    probability = payload.get("probability")
    if isinstance(probability, bool) or not isinstance(probability, (int, float)):
        raise ValueError("shadow probability must be numeric")
    probability = float(probability)
    if not math.isfinite(probability) or not 0 <= probability <= 1:
        raise ValueError("shadow probability must be finite and between zero and one")
    if kafka_key != f"{tenant}:{event_id}".encode("ascii"):
        raise ValueError("Kafka key does not match tenant and event identity")
    return ShadowPrediction(tenant, subject_id, source_event_id, prediction_id, probability)
