#!/usr/bin/env python3
"""Guard the separation between central-only and operational shard DB secrets."""

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SQL = ROOT / "../../gitops/disposable/rds-bootstrap-chart/files/init-databases.sql"
RUNTIME = ROOT / "runtime-secrets.tf"
SHARDS = ROOT / "shard-secret-values.tf"
CENTRAL_ONLY = {
    "CONTROL_DB_PASSWORD",
    "CONTROL_ENTITLEMENT_PROJECTOR_PASSWORD",
    "CONTROL_MIGRATOR_PASSWORD",
    "CONTROL_AUDIT_WORKER_PASSWORD",
    "BILLING_DB_PASSWORD",
    "BILLING_MIGRATOR_PASSWORD",
    "BILLING_AUDIT_READER_PASSWORD",
}


class ShardBootstrapSecretScopeTest(unittest.TestCase):
    def test_shard_password_profile_excludes_central_only_credentials(self):
        sql = SQL.resolve().read_text()
        runtime = RUNTIME.read_text()
        shard_values = SHARDS.read_text()
        sql_keys = set(re.findall(r"(?m)^\\getenv\s+\S+\s+(\S+)\s*$", sql))
        self.assertTrue(CENTRAL_ONLY <= sql_keys)
        operational_keys = sql_keys - CENTRAL_ONLY
        self.assertTrue(operational_keys)
        self.assertIn("PROJECTION_HISTORY_MAINTAINER_PASSWORD", operational_keys)
        for key in CENTRAL_ONLY:
            key_line = next(line for line in sql.splitlines() if line.startswith("\\getenv ") and line.endswith(key))
            self.assertGreater(sql.index(key_line), sql.index("\\else\n-- Stage 09a tenant-control-plane"))

        block = re.search(
            r"runtime_central_only_bootstrap_role_keys\s*=\s*toset\(\[(.*?)\]\)",
            runtime,
            re.DOTALL,
        )
        self.assertIsNotNone(block)
        configured_central_keys = set(re.findall(r'"([A-Z][A-Z0-9_]+)"', block.group(1)))
        self.assertEqual(configured_central_keys, CENTRAL_ONLY)
        self.assertIn(
            "runtime_shard_bootstrap_role_keys = setsubtract(local.runtime_bootstrap_role_keys, local.runtime_central_only_bootstrap_role_keys)",
            runtime,
        )
        self.assertIn(
            "toset(keys(passwords)) == local.runtime_shard_bootstrap_role_keys",
            shard_values,
        )
        self.assertRegex(
            shard_values,
            r"secret_string_wo\s*= jsonencode\(var\.shard_role_passwords\[each\.key\]\)",
        )
        # The filtered profile handed to the shard Secret cannot contain any
        # of the central-only keys even though they are found in the shared SQL.
        self.assertTrue(CENTRAL_ONLY.isdisjoint(operational_keys))


if __name__ == "__main__":
    unittest.main()
