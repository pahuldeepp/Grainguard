"""Isolated PostgreSQL contract test for per-tenant ownership bootstrap.

Run directly with Python. It starts and removes a uniquely named throwaway
PostgreSQL container; it never connects to GreenGuard Compose or AWS.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import time
import unittest
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
CANONICAL = ROOT / "services/tenant-control-plane/migrations/tenant-ownership-bootstrap-per-tenant.sql"
RECEIPT_CANONICAL = ROOT / "services/tenant-control-plane/migrations/tenant-ownership-bootstrap-receipt.sql"
MIGRATIONS = (
    "services/device-service/prisma/migrations/20260928230000_tenant_ownership_bootstrap/migration.sql",
    "services/telemetry-ingest/migrations/000021_tenant_ownership_bootstrap.up.sql",
    "services/projection-builder/migrations/000024_tenant_ownership_bootstrap.up.sql",
    "services/jobs-worker/migrations/000010_tenant_ownership_bootstrap.up.sql",
    "services/saga-orchestrator/migrations/000012_tenant_ownership_bootstrap.up.sql",
    "services/hardware-service/migrations/000009_tenant_ownership_bootstrap.up.sql",
    "services/workflow-alerts/prisma/migrations/20260928230000_tenant_ownership_bootstrap/migration.sql",
    "services/notification-service/migrations/0007_tenant_ownership_bootstrap.sql",
    "services/risk-engine/migrations/000012_tenant_ownership_bootstrap.up.sql",
)
RECEIPT_MIGRATIONS = (
    "services/device-service/prisma/migrations/20260928240000_tenant_ownership_bootstrap_receipt/migration.sql",
    "services/telemetry-ingest/migrations/000022_tenant_ownership_bootstrap_receipt.up.sql",
    "services/projection-builder/migrations/000025_tenant_ownership_bootstrap_receipt.up.sql",
    "services/jobs-worker/migrations/000011_tenant_ownership_bootstrap_receipt.up.sql",
    "services/saga-orchestrator/migrations/000013_tenant_ownership_bootstrap_receipt.up.sql",
    "services/hardware-service/migrations/000010_tenant_ownership_bootstrap_receipt.up.sql",
    "services/workflow-alerts/prisma/migrations/20260928240000_tenant_ownership_bootstrap_receipt/migration.sql",
    "services/notification-service/migrations/0008_tenant_ownership_bootstrap_receipt.sql",
    "services/risk-engine/migrations/000013_tenant_ownership_bootstrap_receipt.up.sql",
)


class PerTenantBootstrapSQLTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.container = f"gg-owner-bootstrap-sql-{uuid.uuid4().hex[:10]}"
        cls.user = "bootstrap_admin"
        cls.password = uuid.uuid4().hex
        subprocess.run(
            [
                "docker", "run", "--detach", "--rm", "--name", cls.container,
                "-e", f"POSTGRES_USER={cls.user}",
                "-e", f"POSTGRES_PASSWORD={cls.password}",
                "-p", "127.0.0.1::5432", "postgres:16-alpine",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        for _ in range(60):
            logs = subprocess.run(
                ["docker", "logs", cls.container], capture_output=True, text=True
            ).stdout
            ready = subprocess.run(
                ["docker", "exec", cls.container, "psql", "-X", "-U", cls.user, "-d", "postgres", "-Atqc", "SELECT 1"],
                capture_output=True,
                text=True,
            )
            # The official image briefly starts PostgreSQL to initialize its
            # data directory, then restarts it. Wait for the steady-state
            # server as well as a successful query.
            if "PostgreSQL init process complete; ready for start up." in logs and ready.returncode == 0:
                break
            time.sleep(1)
        else:
            logs = subprocess.run(["docker", "logs", cls.container], capture_output=True, text=True).stdout
            subprocess.run(["docker", "rm", "--force", cls.container], capture_output=True)
            raise RuntimeError(f"isolated PostgreSQL container did not become ready: {logs[-2000:]}")
        try:
            cls.psql("""
          CREATE ROLE tenant_ownership_bootstrap NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
          CREATE ROLE runtime_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
          CREATE SCHEMA greenguard_internal;
          CREATE TABLE greenguard_internal.tenant_ownership (
            tenant_id uuid PRIMARY KEY,
            shard_id text NOT NULL CHECK (shard_id IN ('s1','s2','s3','s4')),
            shard_incarnation uuid NOT NULL,
            placement_epoch bigint NOT NULL CHECK (placement_epoch >= 0),
            state text NOT NULL CHECK (state IN ('active','quiescing','fenced','prepared')),
            updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
          );
          REVOKE ALL ON SCHEMA greenguard_internal FROM PUBLIC;
          GRANT USAGE ON SCHEMA greenguard_internal TO PUBLIC;
          REVOKE ALL ON greenguard_internal.tenant_ownership FROM PUBLIC;
          CREATE FUNCTION greenguard_internal.seed_tenant_ownership(jsonb,text,uuid,integer)
            RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
          REVOKE ALL ON FUNCTION greenguard_internal.seed_tenant_ownership(jsonb,text,uuid,integer) FROM PUBLIC;
          GRANT EXECUTE ON FUNCTION greenguard_internal.seed_tenant_ownership(jsonb,text,uuid,integer)
            TO tenant_ownership_bootstrap;
          INSERT INTO greenguard_internal.tenant_ownership
            (tenant_id, shard_id, shard_incarnation, placement_epoch, state)
          VALUES ('10000000-0000-4000-8000-000000000001','s1',
                  '20000000-0000-4000-8000-000000000001',9,'active');
            """)
            cls.psql(CANONICAL.read_text())
            cls.psql(RECEIPT_CANONICAL.read_text())
        except Exception:
            subprocess.run(["docker", "rm", "--force", cls.container], capture_output=True)
            raise

    @classmethod
    def tearDownClass(cls) -> None:
        subprocess.run(["docker", "rm", "--force", cls.container], capture_output=True)

    @classmethod
    def psql(cls, sql: str, *, succeeds: bool = True) -> str:
        result = subprocess.run(
            ["docker", "exec", "-i", cls.container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", cls.user, "-d", "postgres"],
            input=sql,
            capture_output=True,
            text=True,
        )
        if succeeds and result.returncode != 0:
            raise AssertionError(result.stderr)
        if not succeeds and result.returncode == 0:
            raise AssertionError("SQL unexpectedly succeeded")
        return result.stdout

    def test_nine_deployed_copies_match_the_reviewed_contract(self) -> None:
        expected = hashlib.sha256(CANONICAL.read_bytes()).hexdigest()
        self.assertEqual(len(MIGRATIONS), 9)
        self.assertEqual(len(RECEIPT_MIGRATIONS), 9)
        for canonical, migrations in ((CANONICAL, MIGRATIONS), (RECEIPT_CANONICAL, RECEIPT_MIGRATIONS)):
            expected = hashlib.sha256(canonical.read_bytes()).hexdigest()
            for migration in migrations:
                with self.subTest(migration=migration):
                    actual = hashlib.sha256((ROOT / migration).read_bytes()).hexdigest()
                    self.assertEqual(actual, expected)

    def test_authenticated_exact_tuple_receipts_cover_prepared_and_active(self) -> None:
        tenant = "10000000-0000-4000-8000-000000000004"
        incarnation = "20000000-0000-4000-8000-000000000004"
        self.psql(f"SELECT greenguard_internal.prepare_tenant_ownership('{tenant}','s4','{incarnation}',8);")
        prepared = self.psql(f"""
          SET ROLE tenant_ownership_bootstrap;
          SELECT receipt_version || '|' || tenant_id::text || '|' || shard_id || '|' ||
                 shard_incarnation::text || '|' || placement_epoch::text || '|' || state ||
                 '|' || (observed_at IS NOT NULL)::text
            FROM greenguard_internal.get_tenant_ownership_bootstrap_receipt(
              '{tenant}','s4','{incarnation}',8);
          RESET ROLE;
        """)
        self.assertIn(
            f"tenant-ownership-bootstrap-v2|{tenant}|s4|{incarnation}|8|prepared|true",
            prepared,
        )
        self.psql(f"SELECT greenguard_internal.activate_tenant_ownership('{tenant}','s4','{incarnation}',8);")
        active = self.psql(f"""
          SET ROLE tenant_ownership_bootstrap;
          SELECT receipt_version || '|' || tenant_id::text || '|' || shard_id || '|' ||
                 shard_incarnation::text || '|' || placement_epoch::text || '|' || state
            FROM greenguard_internal.get_tenant_ownership_bootstrap_receipt(
              '{tenant}','s4','{incarnation}',8);
          RESET ROLE;
        """)
        self.assertIn(f"tenant-ownership-bootstrap-v2|{tenant}|s4|{incarnation}|8|active", active)
        self.assertIn("tenant-ownership-bootstrap-v2", self.psql(
            "SET ROLE tenant_ownership_bootstrap; SELECT greenguard_internal.tenant_ownership_bootstrap_contract_version(); RESET ROLE;"
        ))
        self.psql(
            f"SET ROLE runtime_app; SELECT * FROM greenguard_internal.get_tenant_ownership_bootstrap_receipt('{tenant}','s4','{incarnation}',8);",
            succeeds=False,
        )
        self.psql(f"SELECT * FROM greenguard_internal.get_tenant_ownership_bootstrap_receipt('{tenant}','s4','{incarnation}',9);", succeeds=False)
        self.psql("SELECT * FROM greenguard_internal.get_tenant_ownership_bootstrap_receipt('10000000-0000-4000-8000-000000000099','s1','20000000-0000-4000-8000-000000000099',1);", succeeds=False)
        self.psql(f"SELECT * FROM greenguard_internal.get_tenant_ownership_bootstrap_receipt('{tenant}','s3','{incarnation}',8);", succeeds=False)

    def test_prepare_activate_are_idempotent_and_never_fence_omitted_tenants(self) -> None:
        tenant = "10000000-0000-4000-8000-000000000002"
        incarnation = "20000000-0000-4000-8000-000000000002"
        self.psql(f"""
          SET ROLE tenant_ownership_bootstrap;
          SELECT greenguard_internal.prepare_tenant_ownership('{tenant}','s2','{incarnation}',1);
          SELECT greenguard_internal.prepare_tenant_ownership('{tenant}','s2','{incarnation}',1);
          RESET ROLE;
        """)
        omitted = self.psql("""
          SELECT state || ':' || shard_id || ':' || placement_epoch::text
            FROM greenguard_internal.tenant_ownership
           WHERE tenant_id='10000000-0000-4000-8000-000000000001';
        """)
        self.assertIn("active:s1:9", omitted)
        prepared = self.psql(f"""
          SELECT state || ':' || shard_id || ':' || placement_epoch::text
            FROM greenguard_internal.tenant_ownership WHERE tenant_id='{tenant}';
        """)
        self.assertIn("prepared:s2:1", prepared)

        self.psql(f"""
          SET ROLE tenant_ownership_bootstrap;
          SELECT greenguard_internal.activate_tenant_ownership('{tenant}','s2','{incarnation}',1);
          SELECT greenguard_internal.activate_tenant_ownership('{tenant}','s2','{incarnation}',1);
          RESET ROLE;
        """)
        active = self.psql(f"SELECT state FROM greenguard_internal.tenant_ownership WHERE tenant_id='{tenant}';")
        self.assertIn("active", active)

    def test_conflicts_and_wrong_epoch_or_incarnation_fail_closed(self) -> None:
        tenant = "10000000-0000-4000-8000-000000000003"
        incarnation = "20000000-0000-4000-8000-000000000003"
        self.psql(f"SELECT greenguard_internal.prepare_tenant_ownership('{tenant}','s3','{incarnation}',4);")
        self.psql(f"SELECT greenguard_internal.prepare_tenant_ownership('{tenant}','s3','{incarnation}',5);", succeeds=False)
        self.psql(f"SELECT greenguard_internal.prepare_tenant_ownership('{tenant}','s3','20000000-0000-4000-8000-000000000004',4);", succeeds=False)
        self.psql(f"SELECT greenguard_internal.activate_tenant_ownership('{tenant}','s3','{incarnation}',5);", succeeds=False)
        self.psql(f"SELECT greenguard_internal.activate_tenant_ownership('{tenant}','s4','{incarnation}',4);", succeeds=False)
        self.psql(f"SELECT greenguard_internal.prepare_tenant_ownership('{tenant}','s3','{incarnation}',0);", succeeds=False)

    def test_bootstrap_role_has_only_function_execution_not_table_access(self) -> None:
        privileges = self.psql("""
          SELECT has_function_privilege('tenant_ownership_bootstrap',
                   'greenguard_internal.prepare_tenant_ownership(uuid,text,uuid,bigint)','EXECUTE')
              || ':' || has_function_privilege('tenant_ownership_bootstrap',
                   'greenguard_internal.activate_tenant_ownership(uuid,text,uuid,bigint)','EXECUTE')
              || ':' || has_function_privilege('tenant_ownership_bootstrap',
                   'greenguard_internal.seed_tenant_ownership(jsonb,text,uuid,integer)','EXECUTE')
              || ':' || has_function_privilege('tenant_ownership_bootstrap',
                   'greenguard_internal.get_tenant_ownership_bootstrap_receipt(uuid,text,uuid,bigint)','EXECUTE')
              || ':' || has_function_privilege('tenant_ownership_bootstrap',
                   'greenguard_internal.tenant_ownership_bootstrap_contract_version()','EXECUTE')
              || ':' || has_function_privilege('runtime_app',
                   'greenguard_internal.prepare_tenant_ownership(uuid,text,uuid,bigint)','EXECUTE')
              || ':' || has_table_privilege('tenant_ownership_bootstrap',
                   'greenguard_internal.tenant_ownership','SELECT')
              || ':' || has_table_privilege('tenant_ownership_bootstrap',
                   'greenguard_internal.tenant_ownership','UPDATE');
        """)
        self.assertIn("true:true:false:true:true:false:false:false", privileges)
        self.psql("""
          SET ROLE tenant_ownership_bootstrap;
          SELECT greenguard_internal.seed_tenant_ownership('[]'::jsonb,'s1',
            '20000000-0000-4000-8000-000000000001',0);
        """, succeeds=False)


if __name__ == "__main__":
    unittest.main()
