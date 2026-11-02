"""Live PostgreSQL tests for the Flink anomaly path (ADR-0031): contract, RLS, idempotency, concurrency.

Skipped unless RISK_DIRECT_URL and RISK_MIGRATION_URL are set (see test_live_db.py). Fresh random
tenants every test, so no cleanup is needed.
"""

import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from risk_engine import events
from risk_engine.apply import APPLIED, DUPLICATE, NOT_READY, QUARANTINE, SKIPPED, Applier
from risk_engine.store import PgDatabase
from risk_engine.consumer import Consumer, DatabaseSink, LotFeed
from risk_engine.health import Metrics
from risk_engine.migrate import MIGRATIONS
from test_apply import validate
from test_fakes import FakeSource, anomaly, binding_changed, lot_changed, new_id, record, registered, telemetry
from test_live_db import APP_URL, OWNER_URL, LATE, psycopg, sql, state

NOW = datetime(2026, 9, 24, 12, 5, tzinfo=timezone.utc)
WHEAT_25 = {"temperature_c": 28.0, "relative_humidity_percent": 50.0}


@unittest.skipUnless(APP_URL and OWNER_URL and psycopg, "live risk database not configured")
class LiveAnomalyTest(unittest.TestCase):
    def setUp(self):
        self.tenant, self.site, self.bin, self.device, self.lot = (new_id() for _ in range(5))
        self.db = PgDatabase(APP_URL)
        self.addCleanup(self.db.close)
        self.applier = self.new_applier(self.db)
        self.sources = {}
        self.apply(registered(self.tenant, self.device, self.site, self.bin))
        self.apply(lot_changed(self.tenant, self.site, self.bin, self.lot, "wheat", 1, "2026-09-24T08:00:00Z"))
        self.apply(telemetry(self.tenant, self.device, self.site, self.bin, "2026-09-24T11:58:00Z",
                             measurements=WHEAT_25))

    @staticmethod
    def new_applier(db):
        return Applier(db, "risk-live", lambda: LATE, clock=lambda: NOW)

    def apply(self, event, applier=None):
        rec = record(event)
        result = (applier or self.applier).apply(rec, events.parse(rec.topic, rec.value, rec.key))
        if event["event_type"] == "telemetry.recorded" and result.outcome in (APPLIED, SKIPPED, DUPLICATE):
            self.sources[(event["tenant_id"], event["aggregate_id"])] = event
        return result

    def flink(self, observed="2026-09-24T12:00:00Z", **kwargs):
        bin_id = kwargs.pop("bin_id", self.bin)
        kwargs.setdefault("source", self.sources.get((self.tenant, self.device)))
        return anomaly(self.tenant, self.device, self.site, bin_id, observed, **kwargs)

    def rows(self, table, tenant=None):
        tenant = tenant or self.tenant
        return sql(OWNER_URL, f"SELECT count(*) FROM {table} WHERE tenant_id = %s", (tenant,), tenant)[0][0]

    def test_published_anomaly_is_persisted_contract_valid_and_idempotent(self):
        event = self.flink()
        first = self.apply(event)
        self.assertEqual((first.outcome, first.reason), (APPLIED, "published"))
        self.assertEqual(self.apply(event).outcome, DUPLICATE)
        self.assertEqual(self.rows("anomaly_decisions"), 1)
        self.assertEqual(self.rows("outbox_events"), 2)
        kinds = sql(OWNER_URL, "SELECT source_kind, score, severity FROM risk_assessments WHERE tenant_id = %s"
                    " ORDER BY aggregate_version", (self.tenant,), self.tenant)
        self.assertEqual([tuple(r) for r in kinds], [("threshold", 25, "normal"), ("anomaly", 50, "warning")])
        payload = sql(OWNER_URL, "SELECT payload, event_type FROM outbox_events WHERE tenant_id = %s"
                      " ORDER BY aggregate_version DESC LIMIT 1", (self.tenant,), self.tenant)[0]
        self.assertEqual(payload[1], "risk.assessed")
        self.assertIn("anomalous_temperature", payload[0]["reasons"])
        outcome = sql(OWNER_URL, "SELECT outcome, base_score, combined_score, assessment_id IS NOT NULL"
                      " FROM anomaly_decisions WHERE tenant_id = %s", (self.tenant,), self.tenant)[0]
        self.assertEqual(tuple(outcome), ("published", 25, 50, True))

    def test_rejected_trigger_releases_partition_and_never_uses_older_corroboration(self):
        source = FakeSource()
        consumer = Consumer(source, DatabaseSink(self.db, "rejected-live"), self.applier, LotFeed(enabled=False), Metrics())
        cause = telemetry(self.tenant, self.device, self.site, self.bin, "2026-09-24T12:01:00Z",
                          measurements={"temperature_c": True})
        event = self.flink("2026-09-24T12:01:00Z", source=cause)
        rec = record(event, partition=2, offset=100)
        consumer.handle(rec)
        self.assertEqual(source.commits, [])
        consumer.handle(record(cause))
        self.assertEqual(self.rows("rejected_telemetry_causes"), 1)
        before = self.rows("outbox_events")
        consumer.handle(rec)
        self.assertEqual(self.rows("outbox_events"), before)
        self.assertEqual(sql(OWNER_URL, "SELECT outcome FROM anomaly_decisions WHERE tenant_id=%s", (self.tenant,), self.tenant)[0][0], "no_corroboration")
        self.assertNotIn((events.ANOMALY_TOPIC, 2), consumer.waiting)
        # A valid subsequent cause and anomaly on the same partition can proceed.
        valid = telemetry(self.tenant, self.device, self.site, self.bin, "2026-09-24T12:02:00Z", measurements=WHEAT_25, version=3)
        consumer.handle(record(valid))
        consumer.handle(record(self.flink("2026-09-24T12:02:00Z", source=valid), partition=2, offset=101))
        self.assertEqual(self.rows("outbox_events"), before + 2)

    def test_rejected_trigger_identity_is_tenant_device_reading_scoped_and_atomic(self):
        from risk_engine.store import StoreError
        cause = telemetry(self.tenant, self.device, self.site, self.bin, "2026-09-24T12:01:00Z")
        identity = (self.tenant, cause["event_id"], self.device, cause["payload"]["reading_id"])
        self.db.quarantine("terminal-test", events.TELEMETRY_TOPIC, 0, 123, "invalid_measurements", "0" * 64, identity)
        with self.db.transaction(self.tenant) as tx:
            self.assertTrue(tx.telemetry_rejected(*identity[1:]))
            self.assertFalse(tx.telemetry_rejected(identity[1], new_id(), identity[3]))
            self.assertFalse(tx.telemetry_rejected(identity[1], identity[2], new_id()))
        with self.db.transaction(new_id()) as tx:
            self.assertFalse(tx.telemetry_rejected(*identity[1:]))
        self.assertEqual(sql(APP_URL, "SELECT count(*) FROM rejected_telemetry_causes")[0][0], 0)
        with state("42501"):
            sql(APP_URL, "INSERT INTO rejected_telemetry_causes (tenant_id, source_event_id, device_id, reading_id, reason) VALUES (%s,%s,%s,%s,'bad')", identity, new_id())
        consumer = "atomic-" + new_id()
        with self.assertRaises(StoreError):
            self.db.quarantine(consumer, events.TELEMETRY_TOPIC, 0, 123, "invalid_measurements", "0" * 64, (*identity[:3], "invalid"))
        self.assertEqual(sql(OWNER_URL, "SELECT count(*) FROM quarantine_samples WHERE consumer_name=%s", (consumer,))[0][0], 0)

    def test_successful_trigger_receipt_wins_over_rejection_from_changed_replay(self):
        cause = self.sources[(self.tenant, self.device)]
        changed = dict(cause)
        changed["payload"] = {**cause["payload"], "measurements": {"temperature_c": True}}
        consumer = Consumer(FakeSource(), DatabaseSink(self.db, "conflict-live"), self.applier, LotFeed(enabled=False), Metrics())
        consumer.handle(record(changed))
        self.assertEqual(self.rows("rejected_telemetry_causes"), 1)
        self.assertEqual(self.apply(self.flink()).reason, "published")

    def test_unidentifiable_quarantine_commits_without_poisoning_cause_state(self):
        from risk_engine.apply import Record
        source = FakeSource()
        consumer = Consumer(source, DatabaseSink(self.db, "malformed-live"), self.applier, LotFeed(enabled=False), Metrics())
        consumer.handle(Record(events.TELEMETRY_TOPIC, 1, 12345, b"{", b"unknown"))
        self.assertEqual(len(source.commits), 1)
        self.assertEqual(self.rows("rejected_telemetry_causes"), 0)
        self.assertEqual(sql(OWNER_URL, "SELECT count(*) FROM quarantine_samples WHERE consumer_name='malformed-live' AND source_offset=12345")[0][0], 1)

    def test_forward_index_cleanup_preserves_current_lot_lookup_index(self):
        names = {r[0] for r in sql(OWNER_URL, "SELECT indexname FROM pg_indexes WHERE schemaname='public'")}
        self.assertNotIn("risk_assessments_bin_publication_idx", names)
        self.assertIn("risk_assessments_bin_lot_publication_idx", names)

    def test_anomaly_waits_for_its_exact_trigger_and_uses_the_committed_new_score(self):
        for score, expected in ((0, "below_threshold"), (25, "published"), (75, "not_higher")):
            with self.subTest(score=score):
                cause = telemetry(self.tenant, self.device, self.site, self.bin,
                                  "2026-09-24T12:01:00Z", version=score + 2,
                                  measurements={"temperature_c": 20 if score == 0 else 40 if score == 75 else 28,
                                                "relative_humidity_percent": 70 if score == 75 else 50})
                event = self.flink("2026-09-24T12:01:00Z", source=cause)
                prior_outbox = self.rows("outbox_events")
                pending = self.apply(event)
                self.assertEqual((pending.outcome, pending.reason), (NOT_READY, "threshold_state_unavailable"))
                self.assertEqual(self.rows("outbox_events"), prior_outbox, "no premature warning publication")
                self.assertEqual(sql(OWNER_URL, "SELECT count(*) FROM consumer_inbox WHERE tenant_id=%s AND event_id=%s",
                                     (self.tenant, event["event_id"]), self.tenant)[0][0], 0)
                # A different Kafka group can process the triggering telemetry first.
                other = Applier(self.db, "threshold-other-group", lambda: LATE, clock=lambda: NOW)
                self.apply(cause, other)
                self.assertEqual(self.apply(event).reason, expected)
                self.assertEqual(self.apply(event).outcome, DUPLICATE)

    def test_receipt_from_another_device_or_reading_does_not_satisfy_trigger_context(self):
        for device, reading in ((new_id(), None), (self.device, new_id())):
            event = self.flink()
            event["aggregate_id"] = event["payload"]["device_id"] = device
            if device != self.device:
                self.apply(registered(self.tenant, device, self.site, self.bin))
            if reading is not None:
                event["payload"]["reading_id"] = reading
            result = self.apply(event)
            self.assertEqual((result.outcome, result.reason), (NOT_READY, "threshold_state_unavailable"))
        self.assertEqual(self.rows("anomaly_decisions"), 0)

    def test_skipped_anomalies_leave_an_audit_row_and_no_outbox_event(self):
        result = self.apply(self.flink(bin_id=None))
        self.assertEqual((result.outcome, result.reason), (SKIPPED, "device_unbound"))
        self.assertEqual((self.rows("anomaly_decisions"), self.rows("outbox_events")), (1, 1))

    def test_late_critical_reading_is_protected_by_publication_order(self):
        critical = telemetry(self.tenant, self.device, self.site, self.bin, "2026-09-24T11:57:00Z",
                             measurements={"temperature_c": 40, "relative_humidity_percent": 70}, version=2)
        self.assertEqual(self.apply(critical).outcome, APPLIED)
        self.assertEqual(self.apply(self.flink()).reason, "not_higher")
        scores = sql(OWNER_URL, "SELECT score FROM risk_assessments WHERE tenant_id = %s"
                     " ORDER BY aggregate_version", (self.tenant,), self.tenant)
        self.assertEqual(scores, [(25,), (75,)])

    def test_another_devices_critical_assessment_protects_the_whole_bin(self):
        other = new_id()
        self.apply(registered(self.tenant, other, self.site, self.bin))
        self.apply(telemetry(self.tenant, other, self.site, self.bin, "2026-09-24T11:59:00Z",
                             measurements={"temperature_c": 40, "relative_humidity_percent": 70}))
        self.assertEqual(self.apply(self.flink()).reason, "not_higher")
        self.assertEqual(self.rows("outbox_events"), 2)

    def test_bin_publication_guard_does_not_mix_tenants_with_the_same_resource_ids(self):
        other_tenant = new_id()
        self.apply(registered(other_tenant, self.device, self.site, self.bin))
        self.apply(lot_changed(other_tenant, self.site, self.bin, self.lot, "wheat", 1,
                               "2026-09-24T08:00:00Z"))
        self.apply(telemetry(other_tenant, self.device, self.site, self.bin, "2026-09-24T11:59:00Z",
                             measurements={"temperature_c": 40, "relative_humidity_percent": 70}))
        self.assertEqual(self.apply(self.flink()).reason, "published")
        self.assertEqual(self.rows("outbox_events"), 2)
        self.assertEqual(self.rows("outbox_events", other_tenant), 1)

    def test_moved_device_cannot_suppress_a_new_advisory_episode_after_clear(self):
        self.apply(telemetry(self.tenant, self.device, self.site, self.bin, "2026-09-24T11:58:30Z",
                             measurements={"temperature_c": 40, "relative_humidity_percent": 70}, version=2))
        self.apply(binding_changed(self.tenant, self.device, self.site, new_id(), 2, 2))
        replacement = new_id()
        self.apply(registered(self.tenant, replacement, self.site, self.bin))
        self.apply(telemetry(self.tenant, replacement, self.site, self.bin, "2026-09-24T11:59:00Z",
                             measurements={"temperature_c": 20, "relative_humidity_percent": 50}))
        self.apply(telemetry(self.tenant, replacement, self.site, self.bin, "2026-09-24T11:59:30Z",
                             measurements=WHEAT_25, version=2))
        result = self.apply(anomaly(self.tenant, replacement, self.site, self.bin, "2026-09-24T12:00:00Z",
                                    source=self.sources[(self.tenant, replacement)]))
        self.assertEqual((result.outcome, result.reason), (APPLIED, "published"))

    def test_previous_lots_critical_score_cannot_suppress_a_new_lot_advisory(self):
        self.apply(telemetry(self.tenant, self.device, self.site, self.bin, "2026-09-24T11:58:30Z",
                             measurements={"temperature_c": 40, "relative_humidity_percent": 70}, version=2))
        new_lot, replacement = new_id(), new_id()
        self.apply(lot_changed(self.tenant, self.site, self.bin, new_lot, "canola", 2,
                               "2026-09-24T11:59:00Z", previous=self.lot))
        self.apply(registered(self.tenant, replacement, self.site, self.bin))
        self.apply(telemetry(self.tenant, replacement, self.site, self.bin, "2026-09-24T11:59:10Z",
                             measurements={"temperature_c": 20, "relative_humidity_percent": 50}))
        self.apply(telemetry(self.tenant, replacement, self.site, self.bin, "2026-09-24T11:59:30Z",
                             measurements=WHEAT_25, version=2))
        result = self.apply(anomaly(self.tenant, replacement, self.site, self.bin, "2026-09-24T12:00:00Z",
                                    source=self.sources[(self.tenant, replacement)]))
        self.assertEqual((result.outcome, result.reason), (APPLIED, "published"))
        self.assertEqual(self.rows("risk_assessment_invalidations"), 0,
                         "old critical history remains intact; it simply belongs to the previous lot")

    def test_delayed_anomaly_for_replaced_lot_is_audited_without_reopening_alerts(self):
        new_lot = new_id()
        self.apply(lot_changed(self.tenant, self.site, self.bin, new_lot, "canola", 2,
                               "2026-09-24T12:01:00Z", previous=self.lot))
        self.apply(telemetry(self.tenant, self.device, self.site, self.bin, "2026-09-24T12:02:00Z",
                             measurements={"temperature_c": 20, "relative_humidity_percent": 50}, version=2))
        event = self.flink("2026-09-24T12:00:00Z")
        result = self.apply(event)
        self.assertEqual((result.outcome, result.reason), (SKIPPED, "superseded_lot"))
        self.assertEqual(self.apply(event).outcome, DUPLICATE)
        self.assertEqual((self.rows("anomaly_decisions"), self.rows("outbox_events")), (1, 2))

    def test_future_lot_placement_does_not_suppress_a_current_lot_advisory(self):
        self.apply(lot_changed(self.tenant, self.site, self.bin, new_id(), "canola", 2,
                               "2026-09-24T13:00:00Z", previous=self.lot))
        self.assertEqual(self.apply(self.flink()).reason, "published")

    def test_skipped_decisions_are_idempotent_across_groups_and_reject_changed_replays(self):
        event = self.flink(bin_id=None)
        self.assertEqual(self.apply(event).reason, "device_unbound")
        other_group = Applier(self.db, "risk-new-group", lambda: LATE, clock=lambda: NOW)
        self.assertEqual(self.apply(event, other_group).outcome, DUPLICATE)
        event["payload"]["value"] += 1
        conflict = self.apply(event, other_group)
        self.assertEqual((conflict.outcome, conflict.reason), (QUARANTINE, "event_id_conflict"))
        self.assertEqual((self.rows("anomaly_decisions"), self.rows("outbox_events")), (1, 1))

    def test_concurrent_skipped_replay_across_groups_has_one_decision(self):
        event = self.flink(bin_id=None)

        def work(index):
            db = PgDatabase(APP_URL)
            try:
                applier = Applier(db, f"risk-group-{index}", lambda: LATE, clock=lambda: NOW)
                return self.apply(event, applier)
            finally:
                db.close()

        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(work, range(6)))
        self.assertEqual(sorted(r.outcome for r in results), [DUPLICATE] * 5 + [SKIPPED])
        self.assertEqual(self.rows("anomaly_decisions"), 1)

    def test_upgrade_backfills_skipped_and_published_receipts_and_restores_forced_rls(self):
        self.apply(self.flink(bin_id=None))
        self.apply(self.flink())
        # Recreate pre-upgrade receipt names inside a rollback-only transaction.
        # The migration itself must carry receipts across all tenants despite FORCE RLS.
        conn = psycopg.connect(OWNER_URL, prepare_threshold=None)
        try:
            conn.execute("SELECT set_config('app.tenant_id', %s, true)", (self.tenant,))
            conn.execute("UPDATE consumer_inbox SET consumer_name = 'legacy-risk-group'"
                         " WHERE tenant_id = %s AND event_type = 'telemetry.anomaly'", (self.tenant,))
            conn.execute("DROP INDEX IF EXISTS risk_assessments_bin_publication_idx")
            conn.execute((MIGRATIONS / "000006_anomaly_replay_scope.up.sql").read_text())
            receipts = conn.execute("SELECT count(*) FROM consumer_inbox WHERE tenant_id = %s"
                                    " AND consumer_name = 'risk-engine.anomaly.v1'", (self.tenant,)).fetchone()
            self.assertEqual(receipts[0], 2)
            forced = conn.execute("SELECT relname, relforcerowsecurity FROM pg_class"
                                  " WHERE oid IN ('consumer_inbox'::regclass, 'anomaly_decisions'::regclass)"
                                  " ORDER BY relname").fetchall()
            self.assertEqual(forced, [("anomaly_decisions", True), ("consumer_inbox", True)])
        finally:
            conn.rollback()
            conn.close()

    def test_decisions_are_tenant_isolated_and_insert_only(self):
        self.apply(self.flink())
        other = new_id()
        self.assertEqual(self.rows("anomaly_decisions", other), 0)
        reader = PgDatabase(APP_URL)
        self.addCleanup(reader.close)
        with reader.transaction(other) as tx:
            tx.cur.execute("SELECT count(*) FROM anomaly_decisions")
            self.assertEqual(tx.cur.fetchone()[0], 0, "forced RLS hides another tenant's decisions")
        with state("42501"):
            sql(APP_URL, "UPDATE anomaly_decisions SET outcome = 'not_higher'", (), self.tenant)
        with state("42501"):
            sql(APP_URL, "DELETE FROM anomaly_decisions", (), self.tenant)
        with state("42501"):  # RLS with-check or privilege: a tenant cannot write another tenant's row
            sql(APP_URL, "INSERT INTO anomaly_decisions (tenant_id, anomaly_event_id, device_id, metric, detector,"
                " outcome, observed_at) VALUES (%s, %s, %s, 'temperature_c', 'zscore', 'too_old', now())",
                (other, new_id(), self.device), self.tenant)

    def test_published_outcome_requires_an_assessment(self):
        with state("23514"):
            sql(OWNER_URL, "INSERT INTO anomaly_decisions (tenant_id, anomaly_event_id, device_id, metric, detector,"
                " outcome, observed_at) VALUES (%s, %s, %s, 'temperature_c', 'zscore', 'published', now())",
                (self.tenant, new_id(), self.device), self.tenant)

    def test_concurrent_anomalies_publish_exactly_one_assessment(self):
        events_ = [self.flink(f"2026-09-24T12:0{i}:00Z") for i in range(6)]

        def work(event):
            db = PgDatabase(APP_URL)
            try:
                return self.apply(event, self.new_applier(db))
            finally:
                db.close()

        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(work, events_))
        self.assertEqual(sorted(r.reason for r in results), ["not_higher"] * 5 + ["published"])
        self.assertEqual(self.rows("anomaly_decisions"), 6)
        versions = [r[0] for r in sql(OWNER_URL, "SELECT aggregate_version FROM outbox_events WHERE tenant_id = %s"
                                      " ORDER BY aggregate_version", (self.tenant,), self.tenant)]
        self.assertEqual(versions, [1, 2], "one threshold and one anomaly assessment, nothing duplicated")

    def test_concurrent_anomalies_and_readings_keep_one_gapless_ordered_stream(self):
        jobs = []
        for i in range(8):
            jobs.append(("reading", telemetry(self.tenant, self.device, self.site, self.bin,
                                              f"2026-09-24T12:0{i % 4}:3{i}Z", measurements=WHEAT_25, version=i + 2)))
            jobs.append(("anomaly", self.flink(f"2026-09-24T12:0{i % 4}:0{i}Z", detector="zscore")))

        def work(job):
            db = PgDatabase(APP_URL)
            try:
                return self.apply(job[1], self.new_applier(db))
            finally:
                db.close()

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(work, jobs))
        self.assertTrue(all(r.outcome in (APPLIED, SKIPPED, DUPLICATE) for r in results), [r for r in results])
        rows = sql(OWNER_URL, "SELECT aggregate_version, payload FROM outbox_events WHERE tenant_id = %s"
                   " ORDER BY aggregate_version", (self.tenant,), self.tenant)
        versions = [r[0] for r in rows]
        self.assertEqual(versions, list(range(1, len(versions) + 1)), "versions are gapless and unique")
        self.assertEqual(self.rows("anomaly_decisions"), 8, "every anomaly decided exactly once")
        self.assertEqual(self.rows("risk_assessments"), len(rows))
        for _, payload in rows:
            self.assertLessEqual(payload["score"], 74 if "anomalous_temperature" in payload["reasons"] else 100)
        self.assertEqual([int(payload["assessment_version"]) for _, payload in rows], versions,
                         "CDC requires the payload version to match the published stream version")


if __name__ == "__main__":
    unittest.main()
