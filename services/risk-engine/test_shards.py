import copy
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from risk_engine.shards import ShardedDatabase, authority_fetcher, validate_route
from risk_engine.store import PgDatabase, StoreError
from risk_engine.health import Metrics

TENANT = "a1111111-1111-4111-8111-111111111111"
INCARNATION = "b1111111-1111-4111-8111-111111111111"


def route(shard="s1", **changes):
    return {"tenantId": TENANT, "shardId": shard, "shardIncarnation": INCARNATION,
            "placementEpoch": "9007199254740993", "state": "active",
            "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat(), **changes}


def manifest():
    return {"formatVersion": 1, "service": "risk-engine", "database": "greenguard_risk",
            "shards": {shard: {"incarnation": INCARNATION,
                                "primaryUrl": f"postgresql://risk_app:p@127.0.0.1:{5431+i}/greenguard_risk?sslmode=disable",
                                "replicaUrls": []} for i, shard in enumerate(("s1", "s2", "s3", "s4"))}}


class FakeDatabase:
    def __init__(self, url):
        self.url, self.calls, self.closed, self.healthy = url, [], False, True

    @contextmanager
    def transaction(self, tenant, placement):
        self.calls.append((tenant, placement))
        yield self

    def quarantine(self, *args):
        self.calls.append(args)

    def ping(self):
        return self.healthy

    def close(self):
        self.closed = True


class ShardTest(unittest.TestCase):
    def test_authority_latency_and_failure_metrics_are_bounded(self):
        metrics = Metrics()
        state = [route()]
        db = ShardedDatabase(manifest(), lambda t: state[0], allow_loopback=True,
                             database=FakeDatabase, observe=metrics.observe_placement)
        with db.transaction(TENANT):
            pass
        state[0] = route(state="quiescing")
        with self.assertRaises(StoreError), db.transaction(TENANT):
            pass
        self.assertEqual(metrics.value("greenguard_risk_placement_requests_total", outcome="ok"), 1)
        self.assertEqual(metrics.value("greenguard_risk_placement_requests_total", outcome="error"), 1)
        self.assertIn("greenguard_risk_placement_request_seconds_count 2", metrics.render())
        self.assertNotIn(TENANT, metrics.render())

    def build(self, fetch=lambda tenant: route()):
        return ShardedDatabase(manifest(), fetch, allow_loopback=True, database=FakeDatabase)

    def test_all_four_routes_preserve_exact_epoch(self):
        for shard in ("s1", "s2", "s3", "s4"):
            db = self.build(lambda tenant: route(shard))
            with db.transaction(TENANT) as tx:
                self.assertIs(tx, db.databases[shard])
            self.assertEqual(db.databases[shard].calls[0][1]["placementEpoch"], "9007199254740993")
            self.assertEqual(sum(len(d.calls) for d in db.databases.values()), 1)

    def test_failed_or_invalid_authority_never_queries_a_primary(self):
        values = [route(state="quiescing"), route(shard="s5"), route(placementEpoch="9223372036854775808"),
                  route(shardIncarnation="c1111111-1111-4111-8111-111111111111"),
                  route(tenantId="c1111111-1111-4111-8111-111111111111"),
                  route(expiresAt="2020-01-01T00:00:00Z"), route(extra="ignored")]
        for value in values:
            db = self.build(lambda tenant: value)
            with self.assertRaises(StoreError), db.transaction(TENANT):
                self.fail("invalid authority admitted tenant")
            self.assertTrue(all(not d.calls for d in db.databases.values()))
        def unavailable(tenant):
            raise OSError("upstream secret")
        db = self.build(unavailable)
        with self.assertRaisesRegex(StoreError, "authority unavailable"), db.transaction(TENANT):
            pass
        self.assertTrue(all(not d.calls for d in db.databases.values()))

    def test_entire_registry_validated_before_allocating(self):
        invalid = manifest()
        invalid["shards"]["s4"]["primaryUrl"] = invalid["shards"]["s1"]["primaryUrl"].replace(":p@", ":other@")
        opened = []
        fetch_route = lambda t: route()
        with self.assertRaisesRegex(ValueError, "duplicate"):
            ShardedDatabase(invalid, fetch_route, allow_loopback=True, database=opened.append)
        self.assertEqual(opened, [])
        for bad in ("?sslmode=disable", "?sslmode=verify-full", "?sslmode=verify-full&sslrootcert=/ca&options=-c%20role=admin"):
            invalid = copy.deepcopy(manifest())
            invalid["shards"]["s4"]["primaryUrl"] = "postgresql://risk_app:p@db/greenguard_risk" + bad
            fetch_route = lambda t: route()
            with self.assertRaises(ValueError):
                ShardedDatabase(invalid, fetch_route, database=opened.append)
        self.assertEqual(opened, [])

    def test_explicit_transport_ledger_and_all_shard_health_close(self):
        db = self.build()
        db.quarantine("c", "t", 0, 1, "malformed", "digest")
        self.assertEqual(len(db.databases["s1"].calls), 1)
        self.assertTrue(db.ping())
        db.databases["s4"].healthy = False
        self.assertFalse(db.ping())
        db.close()
        self.assertTrue(all(d.closed for d in db.databases.values()))

    def test_local_active_shard_override_is_scoped_and_fail_closed(self):
        db = ShardedDatabase(manifest(), lambda tenant: route("s2"), allow_loopback=True,
                             active_ids=["s1"], database=FakeDatabase)
        db.databases["s4"].healthy = False
        self.assertTrue(db.ping(), "inactive fixture endpoints must not block local readiness")
        with self.assertRaisesRegex(StoreError, "inactive shard"):
            with db.transaction(TENANT):
                pass
        self.assertTrue(all(not primary.calls for primary in db.databases.values()))

        for active_ids in ([], ["s1", "s1"], ["s5"], ["s2"]):
            registry = manifest()
            fetch_route = lambda tenant: route()
            with self.assertRaisesRegex(ValueError, "active shard override"):
                ShardedDatabase(registry, fetch_route, allow_loopback=True, active_ids=active_ids, database=FakeDatabase)
        normalized = ShardedDatabase(manifest(), lambda tenant: route(), allow_loopback=True,
                                     active_ids=[" s1 "], database=FakeDatabase)
        self.assertTrue(normalized.ping())
        remote = manifest()
        for entry in remote["shards"].values():
            entry["primaryUrl"] = entry["primaryUrl"].replace(
                "127.0.0.1", "db.example"
            ).replace("sslmode=disable", "sslmode=verify-full&sslrootcert=/ca")
        fetch_route = lambda tenant: route()
        with self.assertRaisesRegex(ValueError, "active shard override"):
            ShardedDatabase(remote, fetch_route, allow_loopback=True, active_ids=["s1"], database=FakeDatabase)

    def test_http_requires_tls_or_explicit_loopback_or_mesh(self):
        for url in ("http://control", "https://user:pass@control", "https://control?override=1", "ftp://control"):
            with self.assertRaises(ValueError):
                authority_fetcher(url, "token")
        authority_fetcher("http://127.0.0.1:8000", "token")
        authority_fetcher("http://control", "token", mesh_mtls=True)
        authority_fetcher("https://control", "token")

    def test_sql_admission_precedes_business_and_failure_rolls_back(self):
        class DriverError(Exception):
            sqlstate = "55000"
        class Connection:
            closed = False
            def __init__(self):
                self.calls, self.exits, self.reject = [], [], False
            def transaction(self):
                return self
            def cursor(self):
                return self
            def __enter__(self):
                return self
            def __exit__(self, typ, value, traceback):
                self.exits.append(typ)
            def execute(self, sql, params=()):
                self.calls.append((sql, params))
                if self.reject and "admit_tenant_placement" in sql:
                    raise DriverError("placement fenced")
        conn = Connection()
        db = PgDatabase("u", connect=lambda u: conn, driver_error=lambda: DriverError)
        with db.transaction(TENANT, route()) as tx:
            tx.cur.execute("BUSINESS")
        self.assertIn("admit_tenant_placement", conn.calls[-2][0])
        self.assertEqual(conn.calls[-2][1][-1], "9007199254740993")
        conn.reject = True
        with self.assertRaises(StoreError), db.transaction(TENANT, route()):
            self.fail("fenced transaction reached business")
        self.assertIs(conn.exits[-1], DriverError)


if __name__ == "__main__":
    unittest.main()
