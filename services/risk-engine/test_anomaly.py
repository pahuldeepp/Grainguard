"""Flink anomalies as an advisory risk input (ADR-0031): policy, parsing, apply and consumer behaviour."""

import copy
import json
import threading
import unittest
from unittest import mock
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from risk_engine import anomaly as policy_module
from risk_engine import events, main
from risk_engine.anomaly import AnomalyPolicy, decide
from risk_engine.apply import APPLIED, DUPLICATE, NOT_READY, QUARANTINE, SKIPPED, Applier, Record, RetryPolicy
from risk_engine.consumer import Consumer, LotFeed
from risk_engine.join import Reject, Skip
from risk_engine.health import Metrics
from test_apply import validate
from test_fakes import (FakeDatabase, FakeSink, FakeSource, anomaly, binding_changed, lot_changed, new_id, record,
                        registered, status_changed, telemetry)

UTC = timezone.utc
NOW = datetime(2026, 9, 24, 12, 5, tzinfo=UTC)
LATE = datetime(2030, 1, 1, tzinfo=UTC)
# (temperature, humidity) pairs that the synthetic wheat policy scores 0, 25, 50 and 75.
SCORE = {0: (20.0, 50.0), 25: (28.0, 50.0), 50: (28.0, 70.0), 75: (40.0, 70.0)}


class PolicyTest(unittest.TestCase):
    def test_decision_table(self):
        p = AnomalyPolicy()
        self.assertEqual(decide(p, None, "rapid_change", 50).outcome, "no_corroboration")
        self.assertEqual(decide(p, 0, "zscore", 50).outcome, "below_threshold")
        d = decide(p, 25, "rapid_change", 50)
        self.assertEqual((d.outcome, d.combined, d.points), ("published", 50, 25))
        self.assertEqual(decide(p, 50, "zscore", 50).combined, 74, "an anomaly alone never reaches critical")
        self.assertEqual(decide(p, 75, "zscore", 50).outcome, "not_higher")
        self.assertEqual(decide(p, 100, "zscore", 50).combined, 100, "never lowers a critical base")
        self.assertEqual(decide(p, 25, "zscore", 50, published_score=50).outcome, "not_higher")
        self.assertEqual(decide(p, 25, "zscore", 50, published_score=40).outcome, "published")
        self.assertEqual(decide(AnomalyPolicy(zscore_points=10, rapid_points=40), 25, "zscore", 50).outcome,
                         "below_threshold")
        with self.assertRaises(ValueError):
            p.points("unknown")

    def test_invalid_policy_is_rejected(self):
        for kwargs in ({"cap": 75}, {"cap": 0}, {"zscore_points": 0}, {"rapid_points": 76},
                       {"max_age_s": 0}, {"corroboration_window_s": 8 * 86400}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                AnomalyPolicy(**kwargs)

    def test_environment_configuration(self):
        env = {"RISK_ANOMALY_ZSCORE_POINTS": "30", "RISK_ANOMALY_CAP": "60", "RISK_ANOMALY_MAX_AGE_S": "120"}
        p = policy_module.from_env(env.get)
        self.assertEqual((p.zscore_points, p.cap, p.max_age_s, p.rapid_points), (30, 60, 120, 25))
        self.assertEqual(policy_module.from_env({}.get), AnomalyPolicy())
        for bad in ({"RISK_ANOMALY_CAP": "x"}, {"RISK_ANOMALY_CAP": "90"}):
            with self.assertRaises(ValueError):
                policy_module.from_env(bad.get)


class ParseTest(unittest.TestCase):
    def setUp(self):
        self.t, self.d, self.s, self.b = new_id(), new_id(), new_id(), new_id()

    def parse(self, event, key="auto"):
        rec = record(event, topic=events.ANOMALY_TOPIC, key=key)
        return events.parse(rec.topic, rec.value, rec.key)

    def good(self, **kw):
        return anomaly(self.t, self.d, self.s, self.b, "2026-09-24T12:00:00Z", **kw)

    def test_valid_events_for_both_metrics_and_detectors(self):
        for metric in events.ANOMALY_METRICS:
            for detector in events.ANOMALY_DETECTORS:
                parsed = self.parse(self.good(metric=metric, detector=detector))
                self.assertEqual((parsed.metric, parsed.detector, parsed.bin_id), (metric, detector, self.b))
        self.assertIsNone(self.parse(anomaly(self.t, self.d, self.s, None, "2026-09-24T12:00:00Z")).bin_id)

    def test_schema_version_requires_an_integer_and_never_accepts_boolean_true(self):
        for version in (True, False, 1.0, "1"):
            for event in (self.good(), telemetry(self.t, self.d, self.s, self.b,
                                                 "2026-09-24T12:00:00Z")):
                event["schema_version"] = version
                rec = record(event)
                with self.subTest(version=version, topic=rec.topic), self.assertRaises(events.InvalidEvent):
                    events.parse(rec.topic, rec.value, rec.key)

    def test_invalid_events_are_rejected_with_stable_reasons(self):
        def broken(mutator, key="auto"):
            event = self.good()
            mutator(event)
            with self.assertRaises(events.InvalidEvent) as caught:
                self.parse(event, key)
            return caught.exception.reason

        self.assertEqual(broken(lambda e: None, key=None), "key_mismatch")
        self.assertEqual(broken(lambda e: None, key=f"{new_id()}:{self.d}".encode()), "key_mismatch")
        self.assertEqual(broken(lambda e: None, key=f"{self.t}:{new_id()}".encode()), "key_mismatch")
        self.assertEqual(broken(lambda e: e["payload"].update(metric="co2")), "invalid_event")
        self.assertEqual(broken(lambda e: e["payload"].update(detector="ml")), "invalid_event")
        self.assertEqual(broken(lambda e: e["payload"].update(advisory=False)), "invalid_event")
        self.assertEqual(broken(lambda e: e["payload"].update(extra=1)), "invalid_event")
        self.assertEqual(broken(lambda e: e["payload"].pop("reading_id")), "invalid_event")
        self.assertEqual(broken(lambda e: e["payload"].update(value=True)), "invalid_event")
        self.assertEqual(broken(lambda e: e["payload"].update(value=float("nan"))), "invalid_event")
        self.assertEqual(broken(lambda e: e["payload"].update(value=10**400)), "invalid_event")
        self.assertEqual(broken(lambda e: e["payload"].update(baseline_stddev=-1)), "invalid_event")
        self.assertEqual(broken(lambda e: e["payload"].update(device_id=new_id())), "invalid_event")
        self.assertEqual(broken(lambda e: e["payload"].update(observed_at="yesterday")), "invalid_event")
        self.assertEqual(broken(lambda e: e.update(event_type="telemetry.recorded")), "unsupported_event")
        self.assertEqual(broken(lambda e: e.update(aggregate_type="device")), "unsupported_event")
        self.assertEqual(broken(lambda e: e.update(aggregate_version="1")), "invalid_event")
        self.assertEqual(broken(lambda e: e.update(traceparent="x")), "invalid_event")
        self.assertEqual(broken(lambda e: e.update(tenant_id="T")), "invalid_event")

    def test_other_topics_are_unchanged(self):
        with self.assertRaises(events.InvalidEvent):
            events.parse("greenguard.other.v1", b"{}")
        self.assertEqual(events.topics(), events.TOPICS)
        self.assertEqual(events.topics(True), events.TOPICS + (events.ANOMALY_TOPIC,))


class Scenario:
    def __init__(self, policy=None, now=NOW):
        self.db = FakeDatabase()
        self.now = now
        self.applier = Applier(self.db, "risk-test", lambda: LATE, retry=RetryPolicy(attempts=1),
                               clock=lambda: self.now, anomaly=policy or AnomalyPolicy())
        self.tenant, self.site, self.bin, self.device, self.lot = (new_id() for _ in range(5))
        self.versions = {"inv": 1}
        self.readings = {}

    def apply(self, rec):
        event = events.parse(rec.topic, rec.value, rec.key)
        result = self.applier.apply(rec, event)
        if isinstance(event, events.Telemetry) and result.outcome in (APPLIED, SKIPPED, DUPLICATE):
            self.readings[event.device_id] = event.envelope.raw
        return result

    def setup(self, status="active", bin_id="bin", lot=True):
        target = self.bin if bin_id == "bin" else bin_id
        self.apply(record(registered(self.tenant, self.device, self.site, target, status=status)))
        if lot:
            self.apply(record(lot_changed(self.tenant, self.site, self.bin, self.lot, "wheat", 1,
                                          "2026-09-24T08:00:00Z")))

    def reading(self, observed, score, version=1):
        temp, hum = SCORE[score]
        return self.apply(record(telemetry(self.tenant, self.device, self.site, self.bin, observed,
                                           measurements={"temperature_c": temp, "relative_humidity_percent": hum},
                                           version=version)))

    def anomaly(self, observed="2026-09-24T12:00:00Z", **kwargs):
        kwargs.setdefault("source", self.readings.get(self.device))
        event = anomaly(self.tenant, self.device, self.site, kwargs.pop("bin_id", self.bin), observed, **kwargs)
        return self.apply(record(event)), event

    @property
    def outbox(self):
        return self.db.state["outbox"]

    @property
    def decisions(self):
        return list(self.db.state["decisions"].values())


class ApplyTest(unittest.TestCase):
    def test_anomaly_waits_for_its_triggering_reading_instead_of_losing_corroboration(self):
        sc = Scenario()
        sc.setup()
        cause = telemetry(sc.tenant, sc.device, sc.site, sc.bin, "2026-09-24T12:00:00Z",
                          measurements={"temperature_c": 28, "relative_humidity_percent": 50})
        event = anomaly(sc.tenant, sc.device, sc.site, sc.bin, "2026-09-24T12:00:00Z", source=cause)
        first = sc.apply(record(event))
        self.assertEqual((first.outcome, first.reason), (NOT_READY, "threshold_state_unavailable"))
        self.assertEqual((sc.outbox, sc.decisions), ([], []))
        sc.apply(record(cause))
        self.assertEqual(sc.apply(record(event)).reason, "published")
        self.assertEqual([e["payload"]["score"] for e in sc.outbox], [25, 50])

    def test_anomaly_cannot_use_an_old_warning_before_its_normal_trigger_is_processed(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 25)
        cause = telemetry(sc.tenant, sc.device, sc.site, sc.bin, "2026-09-24T12:00:00Z",
                          measurements={"temperature_c": 20, "relative_humidity_percent": 50}, version=2)
        event = anomaly(sc.tenant, sc.device, sc.site, sc.bin, "2026-09-24T12:00:00Z", source=cause)
        self.assertEqual(sc.apply(record(event)).outcome, NOT_READY)
        sc.apply(record(cause))
        self.assertEqual(sc.apply(record(event)).reason, "below_threshold")
        self.assertEqual([e["payload"]["score"] for e in sc.outbox], [25, 0])

    def test_anomaly_cannot_publish_a_warning_before_its_critical_trigger(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 25)
        cause = telemetry(sc.tenant, sc.device, sc.site, sc.bin, "2026-09-24T12:00:00Z",
                          measurements={"temperature_c": 40, "relative_humidity_percent": 70}, version=2)
        event = anomaly(sc.tenant, sc.device, sc.site, sc.bin, "2026-09-24T12:00:00Z", source=cause)
        self.assertEqual(sc.apply(record(event)).outcome, NOT_READY)
        self.assertEqual([e["payload"]["score"] for e in sc.outbox], [25])
        sc.apply(record(cause))
        self.assertEqual(sc.apply(record(event)).reason, "not_higher")
        self.assertEqual([e["payload"]["score"] for e in sc.outbox], [25, 75])

    def test_payload_and_envelope_versions_match_across_threshold_and_anomaly_publications(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:56:00Z", 25)
        sc.anomaly("2026-09-24T11:57:00Z")
        sc.reading("2026-09-24T11:58:00Z", 50, version=2)
        sc.anomaly("2026-09-24T11:59:00Z")
        self.assertEqual([e["aggregate_version"] for e in sc.outbox], ["1", "2", "3", "4"])
        self.assertEqual([e["payload"]["assessment_version"] for e in sc.outbox], ["1", "2", "3", "4"])

    def test_publication_guard_keeps_critical_after_an_out_of_order_reading(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T12:02:00Z", 25)
        sc.reading("2026-09-24T11:58:00Z", 75, version=2)
        result, _ = sc.anomaly("2026-09-24T12:03:00Z")
        self.assertEqual(result.reason, "not_higher")
        self.assertEqual([e["payload"]["score"] for e in sc.outbox], [25, 75])

    def test_publication_guard_protects_another_device_in_the_same_bin(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 25)
        other = new_id()
        sc.apply(record(registered(sc.tenant, other, sc.site, sc.bin)))
        sc.apply(record(telemetry(sc.tenant, other, sc.site, sc.bin, "2026-09-24T11:59:00Z",
                                  measurements={"temperature_c": 40, "relative_humidity_percent": 70})))
        self.assertEqual(sc.anomaly()[0].reason, "not_higher")
        self.assertEqual([e["payload"]["score"] for e in sc.outbox], [25, 75])

    def test_skipped_anomaly_replay_and_conflict_across_consumer_names(self):
        for kind in ("no_corroboration", "too_old", "device_unbound", "below_threshold", "not_higher"):
            sc = Scenario()
            sc.setup()
            observed = "2026-09-24T12:00:00Z"
            kwargs = {}
            if kind == "too_old":
                observed = "2026-09-24T10:00:00Z"
            elif kind == "no_corroboration":
                sc.apply(record(telemetry(sc.tenant, sc.device, sc.site, sc.bin,
                                          "2026-09-24T12:00:00Z", measurements={"temperature_c": 28})))
            elif kind == "device_unbound":
                kwargs["bin_id"] = None
            elif kind in ("below_threshold", "not_higher"):
                sc.reading("2026-09-24T11:58:00Z", 0 if kind == "below_threshold" else 75)
            first, event = sc.anomaly(observed, **kwargs)
            self.assertEqual(first.reason, kind)
            before = copy.deepcopy(sc.db.state)
            other = Applier(sc.db, "risk-other", lambda: LATE, clock=lambda: NOW + timedelta(days=1))
            rec = record(event)
            self.assertEqual(other.apply(rec, events.parse(rec.topic, rec.value, rec.key)).outcome, DUPLICATE)
            self.assertEqual(sc.db.state, before)
            event["payload"]["value"] += 1
            rec = record(event)
            conflict = other.apply(rec, events.parse(rec.topic, rec.value, rec.key))
            self.assertEqual((conflict.outcome, conflict.reason), (QUARANTINE, "event_id_conflict"))
            self.assertEqual(sc.db.state, before)

    def test_corroborated_anomaly_publishes_a_valid_warning_through_the_outbox(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 25)
        result, event = sc.anomaly()
        self.assertEqual((result.outcome, result.reason), (APPLIED, "published"))
        published = sc.outbox[-1]
        validate(published)
        validate(sc.outbox[0])
        payload = published["payload"]
        self.assertEqual((payload["score"], payload["severity"], payload["alert_eligible"]), (50, "warning", True))
        self.assertEqual(payload["reasons"], ["elevated_temperature", "anomalous_temperature"])
        self.assertEqual((published["causation_id"], payload["source_event_id"]), (event["event_id"],) * 2)
        self.assertEqual(payload["reading_id"], event["payload"]["reading_id"])
        self.assertEqual([e["aggregate_version"] for e in sc.outbox], ["1", "2"])
        stored = next(a for a in sc.db.state["assessments"].values() if a.get("source_kind") == "anomaly")
        self.assertEqual(stored["score"], 50)
        decision = sc.decisions[0]
        self.assertEqual((decision["outcome"], decision["base_score"], decision["combined_score"]),
                         ("published", 25, 50))
        self.assertEqual(decision["assessment_id"], payload["assessment_id"])

    def test_humidity_anomaly_adds_the_humidity_reason(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 25)
        sc.anomaly(metric="relative_humidity_percent", detector="zscore")
        validate(sc.outbox[-1])
        self.assertIn("anomalous_humidity", sc.outbox[-1]["payload"]["reasons"])

    def test_anomaly_never_publishes_without_corroboration_or_below_the_alert_score(self):
        sc = Scenario()
        sc.setup()
        sc.apply(record(telemetry(sc.tenant, sc.device, sc.site, sc.bin,
                                  "2026-09-24T12:00:00Z", measurements={"temperature_c": 28})))
        result, _ = sc.anomaly()
        self.assertEqual((result.outcome, result.reason), (SKIPPED, "no_corroboration"))
        sc.reading("2026-09-24T11:58:00Z", 0)
        result, _ = sc.anomaly("2026-09-24T12:01:00Z")
        self.assertEqual(result.reason, "below_threshold")
        self.assertEqual(len(sc.outbox), 2, "only threshold assessments were published")
        self.assertEqual([d["outcome"] for d in sc.decisions], ["no_corroboration", "below_threshold"])

    def test_critical_threshold_alert_is_never_suppressed_repeated_or_downgraded(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 75)
        before = copy.deepcopy(sc.outbox)
        result, _ = sc.anomaly()
        self.assertEqual(result.reason, "not_higher")
        self.assertEqual(sc.outbox, before, "an anomaly adds nothing on top of a critical assessment")
        self.assertEqual(before[0]["payload"]["severity"], "critical")

    def test_anomaly_alone_cannot_reach_critical(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 50)
        sc.anomaly()
        payload = sc.outbox[-1]["payload"]
        self.assertEqual((payload["score"], payload["severity"]), (74, "warning"))

    def test_repeated_anomalies_do_not_create_repeated_assessments(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 25)
        sc.anomaly()
        second, _ = sc.anomaly("2026-09-24T12:01:00Z")
        self.assertEqual(second.reason, "not_higher")
        self.assertEqual(len(sc.outbox), 2)

    def test_redelivery_is_a_duplicate_and_a_changed_replay_is_quarantined(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 25)
        event = anomaly(sc.tenant, sc.device, sc.site, sc.bin, "2026-09-24T12:00:00Z",
                        source=sc.readings[sc.device])
        first = record(event)
        self.assertEqual(sc.apply(first).outcome, APPLIED)
        self.assertEqual(sc.apply(record(event)).outcome, DUPLICATE)
        self.assertEqual(len(sc.outbox), 2)
        changed = copy.deepcopy(event)
        changed["payload"]["value"] = 99.0
        result = sc.apply(record(changed))
        self.assertEqual((result.outcome, result.reason), (QUARANTINE, "event_id_conflict"))

    def test_device_state_gates(self):
        for name, kwargs, reason in (
                ("unbound device", {"bin_id": None}, "device_unbound"),
                ("disabled device", {"status": "disabled"}, "device_not_active")):
            sc = Scenario()
            sc.setup(**kwargs)
            sc.reading("2026-09-24T11:58:00Z", 25) if kwargs.get("status") else None
            result, _ = sc.anomaly()
            self.assertEqual((result.outcome, result.reason), (SKIPPED, reason), name)
            self.assertEqual(len(sc.outbox), 1 if kwargs.get("status") else 0, name)
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 25)
        result, _ = sc.anomaly(bin_id=None)
        self.assertEqual(result.reason, "device_unbound")
        sc.apply(record(binding_changed(sc.tenant, sc.device, sc.site, new_id(), 2, 2)))
        result, _ = sc.anomaly("2026-09-24T12:01:00Z")
        self.assertEqual(result.reason, "binding_mismatch", "the device moved to another bin")
        self.assertEqual(len(sc.outbox), 1)

    def test_missing_context_is_not_ready_and_leaves_no_trace(self):
        sc = Scenario()
        result, _ = sc.anomaly()
        self.assertEqual((result.outcome, result.reason), (NOT_READY, "binding_state_unavailable"))
        sc.setup(lot=False)
        result, _ = sc.anomaly()
        self.assertEqual((result.outcome, result.reason), (NOT_READY, "lot_state_unavailable"))
        self.assertEqual((sc.decisions, sc.outbox), ([], []))
        self.assertEqual(len(sc.db.state["inbox"]), 1, "only the device registration was recorded")

    def test_stale_and_seven_day_late_anomalies_cannot_open_alerts(self):
        for age in (timedelta(hours=1, seconds=1), timedelta(days=7)):
            sc = Scenario(now=datetime(2026, 9, 24, 12, 0, tzinfo=UTC) + age)
            sc.setup()
            sc.reading("2026-09-24T11:58:00Z", 50)
            result, _ = sc.anomaly()
            self.assertEqual(result.reason, "too_old", str(age))
            self.assertEqual(len(sc.outbox), 1)
        fresh = Scenario(now=datetime(2026, 9, 24, 13, 0, tzinfo=UTC))
        fresh.setup()
        fresh.reading("2026-09-24T11:58:00Z", 25)
        self.assertEqual(fresh.anomaly()[0].reason, "published", "exactly at the age limit is still accepted")

    def test_a_delayed_anomaly_cannot_resurrect_a_condition_that_already_cleared(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 25)
        sc.reading("2026-09-24T12:02:00Z", 0, version=2)  # newer state: back to normal
        result, _ = sc.anomaly("2026-09-24T12:00:00Z")  # Flink delivers it two minutes late
        self.assertEqual(result.reason, "below_threshold")
        self.assertEqual(len(sc.outbox), 2)

    def test_anomaly_arriving_after_an_alert_exists_only_raises_it(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 50)  # already a warning alert
        self.assertTrue(sc.outbox[0]["payload"]["alert_eligible"])
        sc.anomaly()
        self.assertEqual([e["payload"]["score"] for e in sc.outbox], [50, 74])
        self.assertTrue(all(e["payload"]["severity"] == "warning" for e in sc.outbox))

    def test_interleaved_threshold_and_anomaly_assessments_keep_one_ordered_stream(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:56:00Z", 25)
        sc.anomaly("2026-09-24T11:57:00Z")
        sc.reading("2026-09-24T11:58:00Z", 50, version=2)
        sc.anomaly("2026-09-24T11:59:00Z", detector="zscore")
        self.assertEqual([e["aggregate_version"] for e in sc.outbox], ["1", "2", "3", "4"])
        self.assertEqual([e["payload"]["score"] for e in sc.outbox], [25, 50, 50, 74])
        self.assertEqual(len({e["event_id"] for e in sc.outbox}), 4)

    def test_policy_unavailable_for_the_lot_grain_is_quarantined(self):
        sc = Scenario()
        sc.applier.policies = {}
        sc.setup()
        sc.applier.policies = {}
        result, _ = sc.anomaly()
        self.assertEqual((result.outcome, result.reason), (QUARANTINE, "policy_unavailable"))
        self.assertEqual((sc.decisions, sc.outbox), ([], []))

    def test_another_consumer_replaying_the_same_anomaly_finds_the_existing_assessment(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 25)
        _, event = sc.anomaly()
        replay = record(event)
        other = Applier(sc.db, "risk-other-consumer", lambda: LATE, retry=RetryPolicy(attempts=1),
                        clock=lambda: NOW)
        result = other.apply(replay, events.parse(replay.topic, replay.value, replay.key))
        self.assertEqual(result.outcome, DUPLICATE)
        self.assertEqual(len(sc.outbox), 2, "the deterministic IDs make a second consumer a no-op")

    def test_recovered_assessment_without_receipt_is_not_published_again(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 25)
        first, event = sc.anomaly()
        # Model recovery from an older inbox backup while retaining durable assessments.
        del sc.db.state["inbox"][("risk-engine.anomaly.v1", sc.tenant, event["event_id"])]
        replay = sc.apply(record(event))
        self.assertEqual((replay.outcome, replay.assessment_id), (DUPLICATE, first.assessment_id))
        self.assertEqual((len(sc.outbox), len(sc.decisions)), (2, 1))

    def test_unexpected_lot_selection_results_fail_closed(self):
        for choice, reason in ((Reject("binding_conflict"), "binding_conflict"), (Skip("device_unbound"), "binding_conflict")):
            sc = Scenario()
            sc.setup()
            with mock.patch("risk_engine.apply.select_lot", return_value=choice):
                result, _ = sc.anomaly()
            self.assertEqual((result.outcome, result.reason), (QUARANTINE, reason))
            self.assertEqual(sc.decisions, [])

    def test_cross_tenant_anomaly_cannot_touch_another_tenants_device(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 25)
        outsider = new_id()
        forged = anomaly(outsider, sc.device, sc.site, sc.bin, "2026-09-24T12:00:00Z")
        result = sc.apply(record(forged))
        self.assertEqual((result.outcome, result.reason), (NOT_READY, "binding_state_unavailable"))
        self.assertEqual(len(sc.outbox), 1)
        self.assertEqual([k[0] for k in sc.db.state["decisions"]], [])

    def test_backdated_lot_replacement_retracts_an_anomaly_assessment_too(self):
        sc = Scenario()
        sc.setup()
        sc.reading("2026-09-24T11:58:00Z", 25)
        sc.anomaly()
        newer = new_id()
        sc.apply(record(lot_changed(sc.tenant, sc.site, sc.bin, newer, "canola", 2, "2026-09-24T11:00:00Z",
                                    previous=sc.lot)))
        retractions = [e for e in sc.outbox if e["event_type"] == "risk.assessment_invalidated"]
        self.assertEqual(len(retractions), 2, "the threshold and the anomaly assessment are both retracted")

    def test_threshold_assessment_is_identical_with_or_without_anomaly_support(self):
        plain, tuned = Scenario(), Scenario(policy=AnomalyPolicy(zscore_points=40, cap=60))
        for sc in (plain, tuned):
            sc.setup()
            sc.reading("2026-09-24T11:58:00Z", 50)
        keys = ("score", "severity", "alert_eligible", "reasons", "policy_version", "grain_type")
        self.assertEqual({k: plain.outbox[0]["payload"][k] for k in keys},
                         {k: tuned.outbox[0]["payload"][k] for k in keys})


def build_consumer(records=(), source=None, now=NOW):
    db = FakeDatabase()
    source = source or FakeSource(records)
    sink, feed, metrics = FakeSink(), LotFeed(enabled=False), Metrics()
    applier = Applier(db, "risk-test", feed.value, retry=RetryPolicy(attempts=1), clock=lambda: now)
    clock = SimpleNamespace(t=0.0)
    consumer = Consumer(source, sink, applier, feed, metrics, max_wait_s=10, backoff_s=1.0, monotonic=lambda: clock.t)
    return SimpleNamespace(db=db, source=source, sink=sink, metrics=metrics, consumer=consumer, clock=clock)


class ConsumerTest(unittest.TestCase):
    def world(self):
        w = SimpleNamespace(t=new_id(), s=new_id(), b=new_id(), d=new_id(), lot=new_id())
        w.reading = telemetry(w.t, w.d, w.s, w.b, "2026-09-24T11:58:00Z",
                              measurements={"temperature_c": 28.0, "relative_humidity_percent": 50.0})
        return w

    def preload(self, w):
        return [record(registered(w.t, w.d, w.s, w.b)),
                record(lot_changed(w.t, w.s, w.b, w.lot, "wheat", 1, "2026-09-24T08:00:00Z")),
                record(w.reading)]

    def drain(self, c):
        while c.consumer.step(0):
            pass

    def test_anomaly_record_flows_through_the_consumer_and_is_counted(self):
        w = self.world()
        c = build_consumer(self.preload(w) + [record(anomaly(w.t, w.d, w.s, w.b, "2026-09-24T12:00:00Z", source=w.reading))])
        self.drain(c)
        self.assertEqual(len(c.db.state["outbox"]), 2)
        self.assertEqual(c.metrics.value("risk_anomaly_decisions_total", outcome="published"), 1)
        self.assertEqual(c.metrics.value("risk_anomaly_records_started_total"), 1)
        self.assertEqual(c.metrics.value("risk_records_total", topic=events.ANOMALY_TOPIC, outcome="applied"), 1)
        self.assertEqual(len(c.source.commits), 4)

    def test_missing_or_mismatched_trigger_receipt_wait_is_bounded(self):
        w = self.world()
        c = build_consumer(self.preload(w))
        self.drain(c)
        event = anomaly(w.t, w.d, w.s, w.b, "2026-09-24T12:00:00Z", source=w.reading,
                        reading_id=new_id())
        rec = record(event)
        c.consumer.handle(rec)
        self.assertEqual(c.source.commits[-1][0], events.TELEMETRY_TOPIC)
        self.assertEqual(c.db.state["decisions"], {})
        c.clock.t = 11
        c.consumer.handle(rec)
        self.assertEqual(c.sink.items, [], "valid-age anomalies outwait the ordinary context limit")
        c.clock.t = 3601
        c.consumer.handle(rec)
        self.assertEqual(c.sink.items[-1][2], "threshold_state_unavailable")
        self.assertIn((rec.topic, rec.partition, rec.offset), c.source.commits)

    def test_waiting_trigger_expires_as_too_old_when_wall_clock_advances(self):
        w = self.world()
        c = build_consumer(self.preload(w))
        self.drain(c)
        rec = record(anomaly(w.t, w.d, w.s, w.b, "2026-09-24T12:00:00Z",
                             source=w.reading, reading_id=new_id()))
        c.consumer.handle(rec)
        c.consumer.applier.clock = lambda: NOW + timedelta(hours=2)
        c.clock.t = 3601
        c.consumer.handle(rec)
        self.assertEqual(c.sink.items, [])
        self.assertEqual(list(c.db.state["decisions"].values())[0]["outcome"], "too_old")

    def test_invalid_and_mis_keyed_anomalies_are_quarantined_and_never_block(self):
        w = self.world()
        good = anomaly(w.t, w.d, w.s, w.b, "2026-09-24T12:00:00Z", source=w.reading)
        c = build_consumer(self.preload(w) + [
            record(good, key=f"{new_id()}:{w.d}".encode()), Record(events.ANOMALY_TOPIC, 0, 900, b"{"),
            record(good)])
        self.drain(c)
        self.assertEqual([item[2] for item in c.sink.items], ["key_mismatch", "invalid_event"])
        self.assertEqual(len(c.db.state["outbox"]), 2, "the valid anomaly still published")
        self.assertEqual(len(c.source.commits), 6)

    def test_anomaly_waits_for_its_binding_without_blocking_other_topics(self):
        w = self.world()
        waiting = record(anomaly(w.t, w.d, w.s, w.b, "2026-09-24T12:00:00Z", source=w.reading))
        c = build_consumer([waiting])
        c.consumer.step(0)
        self.assertEqual(c.source.paused, [waiting])
        self.assertEqual(c.source.commits, [])
        c.source.queue = self.preload(w)
        for _ in range(3):
            c.consumer.step(0)
        c.clock.t = 1.0
        c.source.queue = [waiting]
        c.consumer.step(0)
        self.assertEqual(len(c.db.state["outbox"]), 2)
        self.assertIn((waiting.topic, waiting.partition, waiting.offset), c.source.commits)

    def test_crash_after_apply_before_commit_then_replay_publishes_once(self):
        w = self.world()
        source = FakeSource(self.preload(w))
        c = build_consumer(source=source)
        self.drain(c)
        anomaly_record = record(anomaly(w.t, w.d, w.s, w.b, "2026-09-24T12:00:00Z", source=w.reading))
        original = source.commit

        def crash(rec):
            raise RuntimeError("process killed before the offset commit")

        source.commit = crash
        source.queue = [anomaly_record]
        with self.assertRaises(RuntimeError):
            c.consumer.step(0)
        self.assertEqual(len(c.db.state["outbox"]), 2, "the effect committed with its outbox row")
        source.commit = original
        source.queue = [anomaly_record]  # Kafka redelivers the uncommitted record to the restarted process
        c.consumer.step(0)
        self.assertEqual(len(c.db.state["outbox"]), 2, "replay found the inbox row and changed nothing")
        self.assertEqual(c.metrics.value("risk_records_total", topic=events.ANOMALY_TOPIC, outcome="duplicate"), 1)
        self.assertIn((anomaly_record.topic, anomaly_record.partition, anomaly_record.offset), source.commits)

    def test_kafka_replay_of_the_whole_anomaly_history_changes_nothing(self):
        w = self.world()
        stream = self.preload(w) + [record(anomaly(w.t, w.d, w.s, w.b, f"2026-09-24T12:0{i}:00Z", source=w.reading)) for i in range(3)]
        c = build_consumer(stream)
        self.drain(c)
        first = copy.deepcopy(c.db.state["outbox"])
        c.source.queue = list(stream)
        self.drain(c)
        self.assertEqual(c.db.state["outbox"], first)
        self.assertEqual(len(first), 2, "three anomalies produced exactly one extra assessment")


class MainConfigTest(unittest.TestCase):
    BASE = {"RISK_DATABASE_URL": "postgresql://x", "KAFKA_BROKERS": "k:9092"}

    def test_configuration_metric_reports_the_effective_optional_flag(self):
        for flag in ("off", "on"):
            stop = threading.Event()
            stop.set()
            seen = []
            db = SimpleNamespace(close=lambda: None, ping=lambda: True)
            source = SimpleNamespace(close=lambda: None)
            main.run({**self.BASE, "RISK_FLINK_ANOMALIES": flag}.get, stop,
                     database=lambda url: db, source=lambda *args: source,
                     start_health=lambda port, metrics, ready: (
                         seen.append(metrics), SimpleNamespace(shutdown=lambda: None))[1])
            self.assertEqual(seen[0].value("risk_configuration_info", flink_anomalies=flag), 1)

    def test_flag_is_off_by_default_and_the_subscription_is_unchanged(self):
        config = main.load_config(self.BASE.get)
        self.assertFalse(config.flink_anomalies)
        seen = {}

        def source(brokers, group, topics, reset):
            seen["topics"] = topics
            raise SystemExit  # stop before connecting anywhere else

        for flag, expected in (({}, events.TOPICS), ({"RISK_FLINK_ANOMALIES": "off"}, events.TOPICS),
                               ({"RISK_FLINK_ANOMALIES": "on"}, events.TOPICS + (events.ANOMALY_TOPIC,))):
            with self.assertRaises(SystemExit):
                main.run({**self.BASE, **flag}.get, database=lambda url: SimpleNamespace(close=lambda: None),
                         source=source)
            self.assertEqual(seen["topics"], expected)

    def test_invalid_flag_or_policy_stops_startup(self):
        for bad in ({"RISK_FLINK_ANOMALIES": "maybe"}, {"RISK_ANOMALY_CAP": "99"}):
            with self.assertRaises(ValueError):
                main.load_config({**self.BASE, **bad}.get)
        config = main.load_config({**self.BASE, "RISK_FLINK_ANOMALIES": "on", "RISK_ANOMALY_CAP": "60"}.get)
        self.assertTrue(config.flink_anomalies)
        self.assertEqual(config.anomaly_policy.cap, 60)


if __name__ == "__main__":
    unittest.main()
