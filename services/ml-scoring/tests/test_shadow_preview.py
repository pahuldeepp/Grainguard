import json
import unittest
from datetime import datetime, timedelta, timezone

from grain_advisor_preview import BinId, RiskAssessment, TenantId, build_preview
from risk_engine.ml_shadow import parse_shadow_prediction
from risk_engine.scoring import Assessment

TENANT = "0a0a0a0a-0000-4000-8000-00000000000a"
BIN = "11111111-1111-4111-8111-111111111111"
EVENT = "22222222-2222-4222-8222-222222222222"
PREDICTION = "33333333-3333-4333-8333-333333333333"
SOURCE = "44444444-4444-4444-8444-444444444444"


def shadow_event():
    event = {
        "event_id": EVENT,
        "event_type": "ml.prediction.shadowed",
        "schema_version": 1,
        "occurred_at": "2026-10-02T12:00:00Z",
        "tenant_id": TENANT,
        "aggregate_type": "ml_prediction",
        "aggregate_id": PREDICTION,
        "causation_id": SOURCE,
        "payload": {
            "prediction_id": PREDICTION,
            "source_event_id": SOURCE,
            "subject_type": "bin",
            "subject_id": BIN,
            "probability": 0.7,
            "target": "simulated_hotspot_onset_48h",
            "mode": "shadow",
            "data_origin": "synthetic_grain_sim",
            "production_eligible": False,
        },
    }
    return event


class ShadowPreviewTests(unittest.TestCase):
    def test_risk_parser_accepts_only_bound_synthetic_shadow_event(self):
        event = shadow_event()
        parsed = parse_shadow_prediction(
            json.dumps(event).encode(), expected_tenant_id=TENANT,
            kafka_key=f"{TENANT}:{EVENT}".encode(),
        )
        self.assertEqual((parsed.tenant_id, parsed.subject_id, parsed.source_event_id),
                         (TENANT, BIN, SOURCE))
        event["payload"]["production_eligible"] = True
        with self.assertRaisesRegex(ValueError, "synthetic-only contract"):
            parse_shadow_prediction(json.dumps(event).encode(), expected_tenant_id=TENANT,
                                    kafka_key=f"{TENANT}:{EVENT}".encode())

    def test_preview_is_informational_and_never_claims_an_action(self):
        event = shadow_event()
        risk = RiskAssessment(TenantId(TENANT), BinId(BIN),
                              Assessment("wheat", 1, 50, "warning", ("synthetic",), True), SOURCE)
        preview = build_preview(risk, shadow_event=event,
                                now=datetime(2026, 10, 2, 12, 1, tzinfo=timezone.utc),
                                max_age=timedelta(days=1))
        self.assertEqual(preview.label, "INFORMATIONAL · NON-ACTIONABLE · SYNTHETIC-ONLY")
        self.assertEqual(preview.deterministic_score, 50)
        self.assertIn("does not alter", preview.shadow_context)
        self.assertIn("No alert, risk state, or operational action", preview.render())

    def test_preview_rejects_foreign_or_stale_shadow(self):
        event = shadow_event()
        risk = RiskAssessment(TenantId(TENANT), BinId(BIN),
                              Assessment("wheat", 1, 50, "warning", (), True), SOURCE)
        event["tenant_id"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        with self.assertRaisesRegex(ValueError, "matching synthetic shadow event"):
            build_preview(risk, shadow_event=event, now=datetime.now(timezone.utc),
                          max_age=timedelta(days=1))

    def test_preview_rejects_stale_event(self):
        risk = RiskAssessment(TenantId(TENANT), BinId(BIN),
                              Assessment("wheat", 1, 50, "warning", (), True), SOURCE)
        with self.assertRaises(ValueError):
            build_preview(risk, shadow_event=shadow_event(),
                          now=datetime(2026, 10, 4, 12, 1, tzinfo=timezone.utc),
                          max_age=timedelta(days=1))

    def test_parser_rejects_boolean_schema_version(self):
        event = shadow_event()
        event["schema_version"] = True
        with self.assertRaises(ValueError):
            parse_shadow_prediction(json.dumps(event).encode(), expected_tenant_id=TENANT,
                                    kafka_key=f"{TENANT}:{EVENT}".encode())


if __name__ == "__main__":
    unittest.main()
