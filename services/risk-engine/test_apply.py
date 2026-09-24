import json
import unittest
from datetime import datetime, timezone

from risk_engine import events
from risk_engine.apply import (APPLIED, DUPLICATE, NOT_READY, QUARANTINE, SKIPPED, STALE, Applier, Record,
                               RetryPolicy, TransientExhausted, build_event, deterministic_ids)
from risk_engine.store import StoreError
from test_fakes import FakeDatabase, binding_changed, lot_changed, new_id, record, registered, status_changed, telemetry

try:
    import jsonschema
except ImportError:  # the pinned dev requirements provide it; system python may not
    jsonschema = None

from test_fakes import ROOT

LATE = datetime(2030, 1, 1, tzinfo=timezone.utc)
SCHEMA = json.loads((ROOT / "contracts/events/risk-assessed.v1.schema.json").read_text(encoding="utf-8"))


def validate(event):
    if jsonschema is None:
        raise unittest.SkipTest("jsonschema not installed")
    jsonschema.Draft202012Validator(SCHEMA, format_checker=jsonschema.FormatChecker()).validate(event)


class Scenario:
    def __init__(self, test, **kwargs):
        self.db = FakeDatabase()
        self.sleeps = []
        self.watermark = LATE
        self.applier = Applier(self.db, "risk-test", lambda: self.watermark, sleep=self.sleeps.append,
                               retry=RetryPolicy(attempts=3), **kwargs)
        self.tenant, self.site, self.bin, self.device = new_id(), new_id(), new_id(), new_id()
        self.wheat, self.canola = new_id(), new_id()

    def apply(self, event, rec=None):
        rec = rec or record(event)
        return self.applier.apply(rec, events.parse(rec.topic, rec.value))

    def setup_wheat_then_canola(self):
        self.apply(registered(self.tenant, self.device, self.site, self.bin))
        self.apply(lot_changed(self.tenant, self.site, self.bin, self.wheat, "wheat", 1, "2026-09-24T08:00:00Z"))
        self.apply(lot_changed(self.tenant, self.site, self.bin, self.canola, "canola", 2,
                               "2026-09-24T12:00:00Z", previous=self.wheat))

    def reading(self, observed_at, **kwargs):
        return telemetry(self.tenant, self.device, self.site, self.bin, observed_at, **kwargs)


class ApplyTelemetryTest(unittest.TestCase):
    def test_late_reading_scores_against_wheat_and_emits_valid_event(self):
        s = Scenario(self)
        s.setup_wheat_then_canola()
        reading = s.reading("2026-09-24T11:00:00Z", measurements={"temperature_c": 23, "relative_humidity_percent": 62})
        result = s.apply(reading)
        self.assertEqual(result.outcome, APPLIED)
        [assessment] = s.db.state["assessments"].values()
        self.assertEqual((assessment["lot_id"], assessment["grain_type"], assessment["score"]), (s.wheat, "wheat", 0))
        [event] = s.db.state["outbox"]
        validate(event)
        self.assertEqual(event["causation_id"], reading["event_id"])
        self.assertEqual(event["correlation_id"], reading["correlation_id"])
        self.assertEqual(event["traceparent"], reading["traceparent"])
        self.assertSequenceEqual((event["event_id"], event["payload"]["assessment_id"]),
                         deterministic_ids(s.tenant, reading["event_id"], s.wheat, 1))
        later = s.apply(s.reading("2026-09-24T12:00:00Z", measurements={"temperature_c": 23, "relative_humidity_percent": 62}))
        self.assertEqual(later.outcome, APPLIED)
        self.assertEqual(s.db.state["outbox"][1]["payload"]["grain_type"], "canola")
        self.assertEqual(s.db.state["outbox"][1]["payload"]["score"], 50)
        self.assertEqual(s.db.state["outbox"][1]["aggregate_version"], "2")

    def test_duplicate_delivery_preserves_result_and_writes_nothing(self):
        s = Scenario(self)
        s.setup_wheat_then_canola()
        reading = s.reading("2026-09-24T11:00:00Z")
        first = s.apply(reading)
        self.assertEqual(s.apply(reading).outcome, DUPLICATE)
        self.assertEqual(len(s.db.state["outbox"]), 1)
        # A replay under a new consumer identity finds the stored assessment: same IDs, no new row.
        replayer = Applier(s.db, "risk-replay", lambda: LATE)
        replay = replayer.apply(record(reading), events.parse(events.TELEMETRY_TOPIC, json.dumps(reading).encode()))
        self.assertEqual((replay.outcome, replay.event_id, replay.assessment_id),
                         (DUPLICATE, first.event_id, first.assessment_id))
        self.assertEqual(len(s.db.state["outbox"]), 1)

    def test_same_event_id_with_different_payload_is_quarantined(self):
        s = Scenario(self)
        s.setup_wheat_then_canola()
        reading = s.reading("2026-09-24T11:00:00Z")
        s.apply(reading)
        tampered = {**reading, "payload": {**reading["payload"], "measurements": {"temperature_c": 1.0}}}
        self.assertEqual(s.apply(tampered).reason, "event_id_conflict")

    def test_not_ready_and_quarantine_roll_back_everything(self):
        s = Scenario(self)
        s.apply(registered(s.tenant, s.device, s.site, s.bin))
        self.assertEqual(s.apply(s.reading("2026-09-24T11:00:00Z")).reason, "lot_state_unavailable")
        s.apply(lot_changed(s.tenant, s.site, s.bin, s.wheat, "wheat", 1, "2026-09-24T08:00:00Z"))
        s.watermark = None
        self.assertEqual(s.apply(s.reading("2026-09-24T11:00:00Z")).reason, "lot_feed_stale")
        s.watermark = LATE
        bad = s.apply(s.reading("2026-09-24T11:00:00Z", measurements={"temperature_c": 1e308 * 10}))
        self.assertEqual((bad.outcome, bad.reason), (QUARANTINE, "invalid_measurements"))
        self.assertEqual(len(s.db.state["lots"]), 1)
        self.assertEqual(s.db.state["assessments"], {})
        self.assertEqual(len(s.db.state["inbox"]), 2)  # registration + lot only

    def test_unknown_grain_and_unbound_device(self):
        s = Scenario(self, policies={})
        s.setup_wheat_then_canola()
        self.assertEqual(s.apply(s.reading("2026-09-24T11:00:00Z")).reason, "policy_unavailable")
        unbound = telemetry(s.tenant, s.device, s.site, None, "2026-09-24T11:00:00Z")
        self.assertEqual(s.apply(unbound).outcome, SKIPPED)

    def test_binding_mismatch_and_missing_binding(self):
        s = Scenario(self)
        self.assertEqual(s.apply(s.reading("2026-09-24T11:00:00Z")).reason, "binding_state_unavailable")
        s.apply(registered(s.tenant, s.device, s.site, new_id()))
        self.assertEqual(s.apply(s.reading("2026-09-24T11:00:00Z")).reason, "binding_conflict")


class ApplyInventoryTest(unittest.TestCase):
    def test_binding_versions_never_regress(self):
        s = Scenario(self)
        other_bin = new_id()
        self.assertEqual(s.apply(binding_changed(s.tenant, s.device, s.site, other_bin, 5, 5)).outcome, APPLIED)
        self.assertEqual(s.apply(registered(s.tenant, s.device, s.site, s.bin, 1, 1)).outcome, STALE)
        self.assertEqual(s.apply(status_changed(s.tenant, s.device, "disabled", 6, 5)).outcome, APPLIED)
        binding = s.db.state["bindings"][(s.tenant, s.device)]
        self.assertEqual((binding.bin_id, binding.status, binding.inventory_version, binding.binding_version),
                         (other_bin, "disabled", 6, 5))

    def test_lot_versions(self):
        s = Scenario(self)
        first = lot_changed(s.tenant, s.site, s.bin, s.wheat, "wheat", 1, "2026-09-24T08:00:00Z")
        self.assertEqual(s.apply(first).outcome, APPLIED)
        self.assertEqual(s.apply(first).outcome, DUPLICATE)
        same_new_id = {**first, "event_id": new_id()}
        self.assertEqual(s.apply(same_new_id).outcome, STALE)
        changed = {**same_new_id, "event_id": new_id(), "payload": {**first["payload"], "grain_type": "oats"}}
        self.assertEqual(s.apply(changed).reason, "lot_version_conflict")
        gap = lot_changed(s.tenant, s.site, s.bin, new_id(), "barley", 3, "2026-09-24T18:00:00Z", previous=s.canola)
        self.assertEqual((s.apply(gap).outcome, s.apply(gap).reason), (NOT_READY, "lot_predecessor_missing"))
        wrong = lot_changed(s.tenant, s.site, s.bin, s.canola, "canola", 2, "2026-09-24T12:00:00Z", previous=new_id())
        self.assertEqual(s.apply(wrong).reason, "lot_predecessor_mismatch")
        backwards = lot_changed(s.tenant, s.site, s.bin, s.canola, "canola", 2, "2026-09-24T07:00:00Z", previous=s.wheat)
        self.assertEqual(s.apply(backwards).reason, "db_rejected")
        self.assertEqual(s.apply(lot_changed(s.tenant, s.site, s.bin, s.canola, "canola", 2,
                                             "2026-09-24T12:00:00Z", previous=s.wheat)).outcome, APPLIED)
        self.assertEqual(s.apply(gap).outcome, APPLIED)
        older = lot_changed(s.tenant, s.site, new_id(), s.wheat, "wheat", 1, "2026-09-24T08:00:00Z")
        self.assertEqual(s.apply(older).outcome, APPLIED)
        self.assertIn((s.tenant, s.bin), s.db.locks)

    def test_stale_older_lot_version_is_ignored(self):
        s = Scenario(self)
        s.apply(lot_changed(s.tenant, s.site, s.bin, s.canola, "canola", 5, "2026-09-24T12:00:00Z", previous=s.wheat))
        older = lot_changed(s.tenant, s.site, s.bin, s.wheat, "wheat", 4, "2026-09-24T08:00:00Z")
        self.assertEqual(s.apply(older).outcome, STALE)

    def test_backdated_lot_change_reports_affected_assessments(self):
        s = Scenario(self)
        s.apply(registered(s.tenant, s.device, s.site, s.bin))
        s.apply(lot_changed(s.tenant, s.site, s.bin, s.wheat, "wheat", 1, "2026-09-24T08:00:00Z"))
        s.apply(s.reading("2026-09-24T11:00:00Z"))
        s.apply(s.reading("2026-09-24T13:00:00Z"))
        other = new_id()
        s.apply(registered(other, s.device, s.site, s.bin))
        s.apply(lot_changed(other, s.site, s.bin, s.wheat, "wheat", 1, "2026-09-24T08:00:00Z"))
        s.apply(telemetry(other, s.device, s.site, s.bin, "2026-09-24T13:00:00Z"))
        replacement = lot_changed(s.tenant, s.site, s.bin, s.canola, "canola", 2,
                                  "2026-09-24T12:00:00Z", previous=s.wheat)
        result = s.apply(replacement)
        self.assertEqual(result.late_assessments, 1)
        [invalidation] = [event for event in s.db.state["outbox"] if event["event_type"] == "risk.assessment_invalidated"]
        if jsonschema is None:
            raise unittest.SkipTest("jsonschema not installed")
        schema = json.loads((ROOT / "contracts/events/risk-assessment-invalidated.v1.schema.json").read_text())
        jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).validate(invalidation)
        self.assertEqual(invalidation["tenant_id"], s.tenant)
        self.assertEqual(invalidation["causation_id"], replacement["event_id"])
        self.assertEqual(invalidation["aggregate_version"], "3")
        self.assertEqual(invalidation["payload"]["observed_at"], "2026-09-24T13:00:00.000000Z")
        self.assertEqual(len(s.db.state["invalidations"]), 1)
        self.assertEqual(s.apply(replacement).outcome, DUPLICATE)
        self.assertEqual(len([e for e in s.db.state["outbox"] if e["event_type"] == "risk.assessment_invalidated"]), 1)

    def test_invalidation_outbox_failure_rolls_back_lot_and_ledger(self):
        s = Scenario(self)
        s.apply(registered(s.tenant, s.device, s.site, s.bin))
        s.apply(lot_changed(s.tenant, s.site, s.bin, s.wheat, "wheat", 1, "2026-09-24T08:00:00Z"))
        s.apply(s.reading("2026-09-24T13:00:00Z"))
        change = lot_changed(s.tenant, s.site, s.bin, s.canola, "canola", 2,
                             "2026-09-24T12:00:00Z", previous=s.wheat)
        s.db.fail("insert_outbox", RuntimeError("crash before commit"))
        with self.assertRaises(RuntimeError):
            s.apply(change)
        self.assertEqual(len(s.db.state["lots"]), 1)
        self.assertEqual(s.db.state["invalidations"], {})
        self.assertEqual(s.apply(change).late_assessments, 1)


class ApplyFailureTest(unittest.TestCase):
    def setUp(self):
        self.s = Scenario(self)
        self.s.setup_wheat_then_canola()
        self.reading = self.s.reading("2026-09-24T11:00:00Z")

    def test_transient_errors_retry_with_bounded_backoff(self):
        self.s.db.fail("insert_outbox", StoreError("40001", "serialization"), StoreError(None, "reset"))
        self.assertEqual(self.s.apply(self.reading).outcome, APPLIED)
        self.assertEqual(self.s.sleeps, [0.2, 0.4])
        self.assertEqual(len(self.s.db.state["outbox"]), 1)

    def test_transient_exhaustion_stops_without_commit(self):
        self.s.db.fail("insert_outbox", *[StoreError("08006", "down")] * 3)
        with self.assertRaises(TransientExhausted):
            self.s.apply(self.reading)
        self.assertEqual(self.s.db.state["assessments"], {})

    def test_crash_before_commit_leaves_nothing_then_redelivery_applies_once(self):
        self.s.db.fail("insert_outbox", RuntimeError("process crash"))
        with self.assertRaises(RuntimeError):
            self.s.apply(self.reading)
        self.assertEqual((self.s.db.state["assessments"], self.s.db.state["outbox"]), ({}, []))
        self.assertEqual(self.s.apply(self.reading).outcome, APPLIED)
        self.assertEqual(self.s.apply(self.reading).outcome, DUPLICATE)

    def test_data_rejections_quarantine_and_rls_denial_is_hard(self):
        self.s.db.fail("insert_assessment", StoreError("23505", "unique"))
        self.assertEqual(self.s.apply(self.reading).reason, "db_rejected")
        self.s.db.fail("insert_assessment", StoreError("42501", "row-level security"))
        with self.assertRaises(StoreError) as caught:
            self.s.apply(self.reading)
        self.assertEqual(caught.exception.sqlstate, "42501")
        self.s.db.fail("insert_assessment", StoreError("XX000", "internal"))
        with self.assertRaises(StoreError):
            self.s.apply(self.reading)

    def test_zero_attempt_policy_is_explicit(self):
        applier = Applier(self.s.db, "x", lambda: LATE, retry=RetryPolicy(attempts=0))
        parsed = events.parse(events.TELEMETRY_TOPIC, json.dumps(self.reading).encode())
        source = record(self.reading)
        with self.assertRaises(TransientExhausted):
            applier.apply(source, parsed)


class BuildEventTest(unittest.TestCase):
    def test_fixture_shape_round_trips_through_contract(self):
        ids = deterministic_ids("t", "s", "l", 1)
        self.assertEqual(ids, deterministic_ids("t", "s", "l", 1))
        self.assertNotEqual(ids, deterministic_ids("t", "s", "l", 2))
        values = {
            "assessment_id": ids[1], "source_event_id": "0d72ff07-a646-4d41-9b5b-52c5f25e4ca8",
            "reading_id": "bb70cd06-0720-461a-8ecf-a56754985f87", "device_id": "33333333-3333-4333-8333-333333333333",
            "bin_id": "55555555-5555-4555-8555-555555555555", "lot_id": "77777777-7777-4777-8777-777777777777",
            "occupancy_version": 1, "grain_type": "wheat", "policy_version": 1, "score": None,
            "severity": "insufficient_data", "alert_eligible": False, "reasons": ["temperature_c"],
            "event_id": ids[0], "aggregate_version": 1, "correlation_id": "4d9d9d30-d209-446e-99ea-d40ab0953d0d",
            "causation_id": "0d72ff07-a646-4d41-9b5b-52c5f25e4ca8", "traceparent": "00-" + "a" * 32 + "-" + "b" * 16 + "-01",
        }
        validate(build_event("11111111-1111-4111-8111-111111111111", values, datetime(2026, 9, 24, tzinfo=timezone.utc)))

    def test_record_is_immutable(self):
        with self.assertRaises(AttributeError):
            Record("t", 0, 0, b"").offset = 1  # type: ignore[misc]


if __name__ == "__main__":
    unittest.main()
