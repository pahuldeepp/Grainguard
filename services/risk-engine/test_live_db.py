"""Live PostgreSQL tests for greenguard_risk (run `make risk-migrate` first).

They run when RISK_DIRECT_URL and RISK_MIGRATION_URL are set (`set -a; . ./.env`).
Every test uses fresh random tenant IDs, so no cleanup (and no DELETE) is needed.
"""

import json
import os
import unittest
import uuid
from datetime import datetime, timezone

from risk_engine import events
from risk_engine.apply import APPLIED, DUPLICATE, STALE, Applier
from risk_engine.consumer import DatabaseSink
from risk_engine.store import PgDatabase, StoreError
from test_apply import validate
from test_fakes import binding_changed, lot_changed, new_id, record, registered, telemetry

APP_URL = os.environ.get("RISK_DIRECT_URL")
POOLED_URL = os.environ.get("RISK_DATABASE_URL")
OWNER_URL = os.environ.get("RISK_MIGRATION_URL")
LATE = datetime(2030, 1, 1, tzinfo=timezone.utc)
TENANT_TABLES = ("consumer_inbox", "device_bindings", "bin_lot_intervals", "device_risk_streams",
                 "risk_assessments", "outbox_events")

try:
    import psycopg
except ImportError:  # the pinned dev requirements provide it
    psycopg = None


def sql(url, statement, params=(), tenant=None):
    with psycopg.connect(url, autocommit=True, prepare_threshold=None) as conn, conn.transaction():
        if tenant:
            conn.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant,))
        cur = conn.execute(statement, params)
        return cur.fetchall() if cur.description else None


def state(sqlstate):
    """Context manager asserting a psycopg error with this SQLSTATE."""
    test = unittest.TestCase()
    return _Expect(test, sqlstate)


class _Expect:
    def __init__(self, test, sqlstate):
        self.test, self.sqlstate = test, sqlstate

    def __enter__(self):
        return self

    def __exit__(self, kind, error, tb):
        self.test.assertIsNotNone(error, f"expected SQLSTATE {self.sqlstate}")
        self.test.assertEqual(getattr(error, "sqlstate", None), self.sqlstate, str(error))
        return True


@unittest.skipUnless(APP_URL and OWNER_URL and psycopg, "live risk database not configured")
class LiveRiskDatabaseTest(unittest.TestCase):
    def setUp(self):
        self.db = PgDatabase(APP_URL)
        self.addCleanup(self.db.close)
        self.applier = Applier(self.db, "risk-live", lambda: LATE)
        self.tenant, self.site, self.bin, self.device = new_id(), new_id(), new_id(), new_id()
        self.wheat, self.canola = new_id(), new_id()

    def apply(self, event, applier=None):
        rec = record(event)
        return (applier or self.applier).apply(rec, events.parse(rec.topic, rec.value))

    def seed(self, tenant=None):
        tenant = tenant or self.tenant
        self.apply(registered(tenant, self.device, self.site, self.bin))
        self.apply(lot_changed(tenant, self.site, self.bin, self.wheat, "wheat", 1, "2026-09-24T08:00:00Z"))
        self.apply(lot_changed(tenant, self.site, self.bin, self.canola, "canola", 2, "2026-09-24T12:00:00Z",
                               previous=self.wheat))

    def reading(self, observed="2026-09-24T11:00:00Z", **kwargs):
        return telemetry(self.tenant, self.device, self.site, self.bin, observed, **kwargs)

    def count(self, table, tenant):
        return sql(OWNER_URL, f"SELECT count(*) FROM {table} WHERE tenant_id = %s", (tenant,), tenant)[0][0]

    def outbox(self, tenant):
        rows = sql(OWNER_URL, "SELECT event_id, event_type, schema_version, occurred_at, tenant_id, aggregate_type,"
                   " aggregate_id, aggregate_version, correlation_id, causation_id, traceparent, payload"
                   " FROM outbox_events WHERE tenant_id = %s ORDER BY aggregate_version", (tenant,), tenant)
        keys = ("event_id", "event_type", "schema_version", "occurred_at", "tenant_id", "aggregate_type",
                "aggregate_id", "aggregate_version", "correlation_id", "causation_id", "traceparent", "payload")
        result = []
        for row in rows:
            event = dict(zip(keys, row))
            for key in ("event_id", "tenant_id", "aggregate_id", "correlation_id", "causation_id"):
                event[key] = str(event[key])
            event["occurred_at"] = events.format_time(event["occurred_at"].astimezone(timezone.utc))
            event["aggregate_version"] = str(event["aggregate_version"])
            result.append(event)
        return result

    def test_event_time_join_and_contract_valid_outbox(self):
        self.seed()
        late = self.reading(measurements={"temperature_c": 23, "relative_humidity_percent": 62})
        after = self.reading("2026-09-24T12:00:00Z", measurements={"temperature_c": 23, "relative_humidity_percent": 62})
        self.assertEqual(self.apply(late).outcome, APPLIED)
        self.assertEqual(self.apply(after).outcome, APPLIED)
        rows = sql(OWNER_URL, "SELECT source_event_id, grain_type, score FROM risk_assessments WHERE tenant_id = %s"
                   " ORDER BY observed_at", (self.tenant,), self.tenant)
        self.assertEqual([(str(r[0]), r[1], r[2]) for r in rows],
                         [(late["event_id"], "wheat", 0), (after["event_id"], "canola", 50)])
        published = self.outbox(self.tenant)
        self.assertEqual(len(published), 2)
        for event in published:
            validate(event)
        self.assertEqual(published[0]["causation_id"], late["event_id"])
        self.assertEqual(published[0]["traceparent"], late["traceparent"])

    def test_duplicate_crash_and_replay(self):
        self.seed()
        reading = self.reading()
        original = self.db.transaction

        def crashing(tenant):
            ctx = original(tenant)

            class Wrapper:
                def __enter__(self_inner):
                    tx = ctx.__enter__()
                    tx.insert_outbox = lambda event: (_ for _ in ()).throw(RuntimeError("crash before commit"))
                    return tx

                def __exit__(self_inner, *exc):
                    return ctx.__exit__(*exc)
            return Wrapper()

        self.db.transaction = crashing
        with self.assertRaises(RuntimeError):
            self.apply(reading)
        self.db.transaction = original
        self.assertEqual([self.count(t, self.tenant) for t in ("risk_assessments", "outbox_events")], [0, 0])
        self.assertEqual(sql(OWNER_URL, "SELECT count(*) FROM consumer_inbox WHERE event_id = %s",
                             (reading["event_id"],), self.tenant)[0][0], 0)
        first = self.apply(reading)
        self.assertEqual(first.outcome, APPLIED)
        self.assertEqual(self.apply(reading).outcome, DUPLICATE)  # crash after commit: redelivery
        pooled = PgDatabase(POOLED_URL or APP_URL)  # replay through PgBouncer when configured
        self.addCleanup(pooled.close)
        replay = self.apply(reading, Applier(pooled, "risk-replay", lambda: LATE))
        self.assertEqual((replay.outcome, replay.event_id), (DUPLICATE, first.event_id))
        self.assertEqual(self.count("outbox_events", self.tenant), 1)

    def test_stale_inventory_cannot_regress(self):
        other_bin = new_id()
        self.apply(binding_changed(self.tenant, self.device, self.site, other_bin, 5, 5))
        self.assertEqual(self.apply(registered(self.tenant, self.device, self.site, self.bin, 1, 1)).outcome, STALE)
        self.assertEqual(sql(OWNER_URL, "SELECT bin_id, inventory_version FROM device_bindings WHERE device_id = %s",
                             (self.device,), self.tenant), [(uuid.UUID(other_bin), 5)])
        with state("23514"):
            sql(APP_URL, "UPDATE device_bindings SET inventory_version = 2 WHERE device_id = %s", (self.device,), self.tenant)
        self.apply(lot_changed(self.tenant, self.site, self.bin, self.canola, "canola", 5, "2026-09-24T12:00:00Z"))
        older = lot_changed(self.tenant, self.site, self.bin, self.wheat, "wheat", 4, "2026-09-24T08:00:00Z")
        self.assertEqual(self.apply(older).outcome, STALE)

    def test_forced_rls_isolates_tenants(self):
        self.seed()
        self.apply(self.reading())
        intruder = new_id()
        for table in TENANT_TABLES:
            with self.subTest(table=table):
                self.assertGreater(self.count(table, self.tenant), 0)
                rows = sql(OWNER_URL, f"SELECT count(*) FROM {table}", (), intruder)
                self.assertEqual(rows[0][0], 0)
                self.assertEqual(sql(OWNER_URL, f"SELECT count(*) FROM {table}")[0][0], 0)
        with state("42501"):
            sql(APP_URL, "INSERT INTO device_bindings (tenant_id, device_id, inventory_version, binding_version,"
                " source_event_id) VALUES (%s, %s, 1, 1, %s)", (self.tenant, new_id(), new_id()), intruder)
        self.assertEqual(sql(APP_URL, "UPDATE bin_lot_intervals SET effective_to = now() WHERE bin_id = %s"
                             " RETURNING 1", (self.bin,), intruder), [])
        # The consumer path: tenant B's transaction cannot see A's binding, so it is not ready.
        stolen = telemetry(intruder, self.device, self.site, self.bin, "2026-09-24T11:00:00Z")
        self.assertEqual(self.apply(stolen).reason, "binding_state_unavailable")

    def test_backdated_placement_retracts_assessment_atomically_and_once(self):
        self.apply(registered(self.tenant, self.device, self.site, self.bin))
        self.apply(lot_changed(self.tenant, self.site, self.bin, self.wheat, "wheat", 1,
                               "2026-09-24T08:00:00Z"))
        self.apply(self.reading("2026-09-24T11:00:00Z"))
        self.apply(self.reading("2026-09-24T13:00:00Z"))
        change = lot_changed(self.tenant, self.site, self.bin, self.canola, "canola", 2,
                             "2026-09-24T12:00:00Z", previous=self.wheat)
        self.assertEqual(self.apply(change).late_assessments, 1)
        self.assertEqual(self.apply(change).outcome, DUPLICATE)
        self.assertEqual(self.count("risk_assessment_invalidations", self.tenant), 1)
        self.assertEqual(self.count("outbox_events", self.tenant), 3)
        invalidation = [e for e in self.outbox(self.tenant)
                        if e["event_type"] == "risk.assessment_invalidated"]
        self.assertEqual(len(invalidation), 1)
        self.assertEqual(invalidation[0]["causation_id"], change["event_id"])
        self.assertEqual(invalidation[0]["aggregate_version"], "3")
        other = new_id()
        self.assertEqual(self.count("risk_assessment_invalidations", other), 0)
        self.assertEqual(sql(OWNER_URL, "SELECT count(*) FROM risk_assessment_invalidations")[0][0], 0)
        assessment_id = sql(OWNER_URL, "SELECT assessment_id FROM risk_assessments"
                            " WHERE tenant_id = %s ORDER BY observed_at DESC LIMIT 1",
                            (self.tenant,), self.tenant)[0][0]
        with state("23503"):
            sql(OWNER_URL, "INSERT INTO risk_assessment_invalidations"
                " (tenant_id, assessment_id, event_id, replacement_lot_id,"
                " replacement_occupancy_version, source_event_id)"
                " VALUES (%s,%s,%s,%s,2,%s)",
                (other, assessment_id, new_id(), self.canola, new_id()), other)
        with state("42501"):
            sql(APP_URL, "DELETE FROM risk_assessment_invalidations WHERE tenant_id = %s",
                (self.tenant,), self.tenant)

    def test_runtime_role_limits(self):
        self.seed()
        self.apply(self.reading())
        for table in TENANT_TABLES + ("quarantine_samples",):
            with self.subTest(table=table), state("42501"):
                sql(APP_URL, f"DELETE FROM {table}", (), self.tenant)
        forbidden = ("UPDATE bin_lot_intervals SET lot_id = %s", "UPDATE bin_lot_intervals SET effective_from = now()",
                     "UPDATE risk_assessments SET score = 1", "UPDATE outbox_events SET payload = '{}'",
                     "UPDATE consumer_inbox SET event = '{}'", "SELECT * FROM outbox_events")
        for statement in forbidden:
            with self.subTest(statement=statement), state("42501"):
                sql(APP_URL, statement, (new_id(),) if "%s" in statement else (), self.tenant)
        with state("23514"):  # the closed wheat interval cannot be reopened or moved
            sql(APP_URL, "UPDATE bin_lot_intervals SET effective_to = now() WHERE bin_id = %s AND occupancy_version = 1",
                (self.bin,), self.tenant)

    def test_overlapping_interval_is_excluded(self):
        self.seed()
        insert = ("INSERT INTO bin_lot_intervals (tenant_id, bin_id, occupancy_version, site_id, lot_id, grain_type,"
                  " effective_from, effective_to, source_event_id) VALUES (%s,%s,%s,%s,%s,'barley',%s,%s,%s)")
        with state("23P01"):
            sql(APP_URL, insert, (self.tenant, self.bin, 3, self.site, new_id(), "2026-09-24T09:00:00Z",
                                  "2026-09-24T10:00:00Z", new_id()), self.tenant)
        with state("23514"):  # occupancy_version must increase
            sql(APP_URL, insert, (self.tenant, self.bin, 1, self.site, new_id(), "2026-01-01T00:00:00Z",
                                  "2026-01-02T00:00:00Z", new_id()), self.tenant)

    def test_invalid_measurements_quarantine_through_database_sink(self):
        self.seed()
        bad = self.reading(measurements={"temperature_c": 500})
        self.assertEqual(self.apply(bad).reason, "invalid_measurements")
        self.assertEqual(self.count("consumer_inbox", self.tenant), 3)
        offset = int.from_bytes(os.urandom(4), "big")
        rec = record(bad, offset=offset)
        sink = DatabaseSink(self.db, "risk-live")
        sink.quarantine(rec, "invalid_measurements")
        sink.quarantine(rec, "invalid_measurements")
        rows = sql(OWNER_URL, "SELECT source_offset, reason FROM quarantine_samples WHERE consumer_name = 'risk-live'"
                   " AND source_topic = %s AND slot = %s", (rec.topic, offset % 1000))
        self.assertEqual(rows, [(offset, "invalid_measurements")])

    def copy_to(self, table, where, params, intruder):
        """Insert tenant A's row into `table` again for `intruder`, keeping every identifier."""
        row = sql(OWNER_URL, f"SELECT to_jsonb(t) FROM {table} t WHERE tenant_id = %s AND {where}",
                  (self.tenant, *params), self.tenant)[0][0]
        row["tenant_id"] = intruder
        sql(OWNER_URL, f"INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table}, %s::jsonb)",
            (json.dumps(row),), intruder)

    def test_same_ids_in_two_tenants_neither_collide_nor_leak(self):
        self.seed()
        self.apply(self.reading())
        assessment_id, event_id = sql(OWNER_URL, "SELECT assessment_id, event_id FROM risk_assessments"
                                      " WHERE tenant_id = %s", (self.tenant,), self.tenant)[0]
        intruder = new_id()
        self.seed(intruder)  # same device/bin/lot ids, now owned by the second tenant
        self.copy_to("risk_assessments", "assessment_id = %s", (assessment_id,), intruder)
        self.copy_to("outbox_events", "event_id = %s", (event_id,), intruder)
        for tenant in (self.tenant, intruder):
            with self.subTest(tenant=tenant):
                self.assertEqual(sql(OWNER_URL, "SELECT DISTINCT tenant_id::text FROM risk_assessments"
                                     " WHERE assessment_id = %s", (assessment_id,), tenant), [(tenant,)])
                self.assertEqual(sql(OWNER_URL, "SELECT DISTINCT tenant_id::text FROM outbox_events"
                                     " WHERE event_id = %s", (event_id,), tenant), [(tenant,)])

    def test_every_unique_key_on_tenant_tables_is_tenant_scoped(self):
        rows = sql(OWNER_URL, "SELECT c.conrelid::regclass::text || '.' || c.conname FROM pg_constraint c"
                   " JOIN pg_class r ON r.oid = c.conrelid"
                   " WHERE c.contype IN ('p', 'u') AND r.relnamespace = 'public'::regnamespace"
                   " AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = r.oid AND a.attname = 'tenant_id')"
                   " AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = r.oid"
                   "   AND a.attname = 'tenant_id' AND a.attnum = ANY(c.conkey))"
                   " ORDER BY 1")
        self.assertEqual(rows, [])

    def test_connection_failures_are_transient_store_errors(self):
        broken = PgDatabase("postgresql://risk_app:wrong@127.0.0.1:1/greenguard_risk?connect_timeout=1")
        self.assertFalse(broken.ping())
        with self.assertRaises(StoreError) as caught:
            with broken.transaction(self.tenant):
                pass
        self.assertIsNone(caught.exception.sqlstate)
        broken.close()
        self.assertTrue(self.db.ping())
        def divide_by_zero():
            with self.db.transaction(self.tenant) as tx:
                tx.cur.execute("SELECT 1/0")

        with self.assertRaises(StoreError) as caught:
            divide_by_zero()
        self.assertEqual(caught.exception.sqlstate, "22012")


if __name__ == "__main__":
    unittest.main()
