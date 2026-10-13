"""Run only against the dedicated scratch acceptance database, never shared .env."""
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone

from risk_engine.store import PgDatabase, StoreError


@unittest.skipUnless(os.environ.get("RISK_SHARD_ACCEPTANCE_URL"), "isolated shard acceptance URL absent")
class ShardAdmissionLiveTest(unittest.TestCase):
    def test_matching_admission_rls_stale_epoch_and_lock_drain(self):
        import psycopg
        tenant, other, incarnation, device, event = (str(uuid.uuid4()) for _ in range(5))
        admin = psycopg.connect(os.environ["RISK_SHARD_ACCEPTANCE_MIGRATOR_URL"], autocommit=True)
        db = PgDatabase(os.environ["RISK_SHARD_ACCEPTANCE_URL"])
        def placement(epoch="1"):
            return {"tenantId": tenant, "shardId": "s2", "shardIncarnation": incarnation,
                    "placementEpoch": epoch, "state": "active",
                    "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat()}
        try:
            admin.execute("CREATE TABLE nullable_tenant_fence_fixture (tenant_id uuid, value integer NOT NULL)")
            admin.execute("ALTER TABLE nullable_tenant_fence_fixture ENABLE ROW LEVEL SECURITY")
            admin.execute("ALTER TABLE nullable_tenant_fence_fixture FORCE ROW LEVEL SECURITY")
            admin.execute("CREATE POLICY tenant_isolation ON nullable_tenant_fence_fixture "
                          "USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) "
                          "WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)")
            admin.execute("CREATE TRIGGER tenant_ownership_row_fence BEFORE INSERT OR UPDATE OR DELETE "
                          "ON nullable_tenant_fence_fixture FOR EACH ROW "
                          "EXECUTE FUNCTION greenguard_internal.enforce_tenant_ownership()")
            admin.execute("GRANT SELECT, INSERT, UPDATE ON nullable_tenant_fence_fixture TO risk_app")
            for owner in (tenant, other):
                admin.execute("INSERT INTO greenguard_internal.tenant_ownership"
                              "(tenant_id,shard_id,shard_incarnation,placement_epoch,state)"
                              " VALUES(%s,'s2',%s,1,'active')", (owner, incarnation))
            with db.transaction(tenant, placement()) as tx:
                tx.cur.execute("INSERT INTO nullable_tenant_fence_fixture VALUES(%s,1)", (tenant,))
                for statement, message in (("UPDATE nullable_tenant_fence_fixture SET tenant_id=NULL WHERE tenant_id=%s", "tenant_id is immutable"),
                                           ("INSERT INTO nullable_tenant_fence_fixture VALUES(NULL,1)", "non-null tenant_id")):
                    tx.cur.execute("SAVEPOINT nullable_fence")
                    with self.assertRaisesRegex(psycopg.errors.InsufficientPrivilege, message):
                        tx.cur.execute(statement, (tenant,) if "%s" in statement else ())
                    tx.cur.execute("ROLLBACK TO SAVEPOINT nullable_fence")
                tx.cur.execute("INSERT INTO device_bindings"
                               "(tenant_id,device_id,inventory_version,binding_version,source_event_id)"
                               " VALUES(%s,%s,1,1,%s)", (tenant, device, event))
                # Shared admission lock drains accepted transactions before a fence.
                admin.execute("SET lock_timeout='100ms'")
                with self.assertRaises(psycopg.errors.LockNotAvailable):
                    admin.execute("UPDATE greenguard_internal.tenant_ownership SET state='fenced' WHERE tenant_id=%s", (tenant,))
                # Explicit wrong-tenant mutation must fail even with a matching epoch.
                tx.cur.execute("SAVEPOINT cross_tenant")
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    tx.cur.execute("INSERT INTO device_bindings"
                                   "(tenant_id,device_id,inventory_version,binding_version,source_event_id)"
                                   " VALUES(%s,%s,1,1,%s)", (other, device, event))
                tx.cur.execute("ROLLBACK TO SAVEPOINT cross_tenant")
            admin.execute("UPDATE greenguard_internal.tenant_ownership SET placement_epoch=2 WHERE tenant_id=%s", (tenant,))
            with self.assertRaises(StoreError) as denied, db.transaction(tenant, placement()):
                self.fail("stale worker admitted")
            self.assertEqual(denied.exception.sqlstate, "55P03")
            with db.transaction(tenant, placement("2")) as tx:
                tx.cur.execute("SELECT device_id FROM device_bindings WHERE tenant_id=%s", (tenant,))
                self.assertEqual(str(tx.cur.fetchone()[0]), device)
            admin.execute("UPDATE greenguard_internal.tenant_ownership SET state='fenced' WHERE tenant_id=%s", (tenant,))
            with self.assertRaises(StoreError), db.transaction(tenant, placement("2")):
                self.fail("fenced worker admitted")
        finally:
            db.close()
            admin.execute("DROP TABLE IF EXISTS nullable_tenant_fence_fixture")
            admin.close()


if __name__ == "__main__":
    unittest.main()
