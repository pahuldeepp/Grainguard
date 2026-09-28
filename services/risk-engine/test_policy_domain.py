import json
import unittest
from datetime import datetime, timezone

import jsonschema

from risk_engine.policy import PolicyVersion, validate_policy
from risk_engine.policy_service import PolicyService, VerifiedPrincipal
from test_fakes import ROOT

TENANT = "22222222-2222-4222-8222-222222222222"
POLICY = "33333333-3333-4333-8333-333333333333"
NOW = datetime(2026, 9, 26, tzinfo=timezone.utc)


def policy(**changes):
    values = {
        "tenant_id": TENANT, "policy_id": POLICY, "version": 1, "grain_type": "wheat", "bin_id": None,
        "effective_from": NOW, "effective_to": None,
        "measurement_thresholds": {
            "temperature_c": {"warning": 25.0, "critical": 35.0, "unit": "Cel"},
            "relative_humidity_percent": {"warning": 65.0, "critical": 80.0, "unit": "%"},
        },
        "risk_thresholds": {"warning_score": 50, "critical_score": 75},
        "calibrated": False, "status": "draft", "provenance": {"source": "synthetic_fixture"},
        "calibration_evidence": None, "approved_by": None, "approved_at": None,
    }
    values.update(changes)
    return PolicyVersion(**values)


class PolicyValidationTest(unittest.TestCase):
    def test_unapproved_synthetic_values_are_draft_and_uncalibrated(self):
        validate_policy(policy())
        with self.assertRaisesRegex(ValueError, "cannot be active"):
            validate_policy(policy(status="active"))

    def test_calibration_requires_evidence_and_approval(self):
        with self.assertRaisesRegex(ValueError, "require evidence"):
            validate_policy(policy(calibrated=True, status="active"))
        validate_policy(policy(calibrated=True, status="active", calibration_evidence="AGR-42",
                               approved_by="agronomist", approved_at=NOW))

    def test_active_policy_requires_scoring_thresholds_and_reachable_warning(self):
        with self.assertRaisesRegex(ValueError, "active policies require"):
            validate_policy(policy(calibrated=True, status="active", calibration_evidence="AGR-42",
                                   approved_by="agronomist", approved_at=NOW,
                                   measurement_thresholds={}))
        for metric in ("temperature_c", "relative_humidity_percent"):
            for bound in ("warning", "critical"):
                thresholds = {
                    "temperature_c": {"warning": 25.0, "critical": 35.0, "unit": "Cel"},
                    "relative_humidity_percent": {"warning": 65.0, "critical": 80.0, "unit": "%"},
                }
                thresholds[metric][bound] = None
                with self.subTest(metric=metric, bound=bound), self.assertRaisesRegex(ValueError, "finite"):
                    validate_policy(policy(calibrated=True, status="active", calibration_evidence="AGR-42",
                                           approved_by="agronomist", approved_at=NOW,
                                           measurement_thresholds=thresholds))
        with self.assertRaisesRegex(ValueError, "at most 75"):
            validate_policy(policy(risk_thresholds={"warning_score": 76, "critical_score": 90}))

    def test_measurement_validation_is_unit_aware_finite_and_optional(self):
        validate_policy(policy(measurement_thresholds={
            "co2_ppm": {"warning": None, "critical": None, "unit": "ppm"},
            "grain_moisture_percent": {"warning": 12.0, "critical": 16.0, "unit": "%"},
        }))
        for thresholds in (
            {"temperature_c": {"warning": 35.0, "critical": 25.0, "unit": "Cel"}},
            {"co2_ppm": {"warning": float("inf"), "critical": None, "unit": "ppm"}},
            {"relative_humidity_percent": {"warning": 65.0, "critical": 80.0, "unit": "Cel"}},
        ):
            with self.subTest(thresholds=thresholds), self.assertRaises(ValueError):
                validate_policy(policy(measurement_thresholds=thresholds))

    def test_policy_service_binds_tenant_role_and_calibration_approver(self):
        class Tx:
            def __init__(self):
                self.saved = []
            def create_policy(self, value, event):
                self.saved.append((value, event))
        class DB:
            def __init__(self):
                self.tx = Tx()
                self.tenant = None
            class Ctx:
                def __init__(self, db, tenant): self.db, self.tenant = db, tenant
                def __enter__(self): self.db.tenant = self.tenant; return self.db.tx
                def __exit__(self, *_): return False
            def transaction(self, tenant): return self.Ctx(self, tenant)
        db = DB()
        service = PolicyService(db, clock=lambda: NOW)
        reader = VerifiedPrincipal(TENANT, "reader", frozenset({"viewer"}))
        with self.assertRaises(PermissionError):
            service.publish(reader, policy())
        wrong_tenant = VerifiedPrincipal("44444444-4444-4444-8444-444444444444",
                                         "admin", frozenset({"admin"}))
        with self.assertRaises(PermissionError):
            service.publish(wrong_tenant, policy(tenant_id=TENANT))
        admin = VerifiedPrincipal(TENANT, "admin", frozenset({"admin"}))
        event = service.publish(admin, policy())
        self.assertEqual(db.tenant, TENANT)
        self.assertEqual(event["event_type"], "risk.policy_changed")
        self.assertEqual(event["payload"]["calibrated"], False)
        self.assertEqual(event["aggregate_version"], "1")
        schema = json.loads((ROOT / "contracts/events/risk-policy-changed.v1.schema.json").read_text())
        jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).validate(event)
        self.assertEqual(len(db.tx.saved), 1)


if __name__ == "__main__":
    unittest.main()
