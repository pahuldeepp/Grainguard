import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CHART = ROOT / "ai-database-bootstrap-chart"


class AiDatabaseBootstrapChartTests(unittest.TestCase):
    def test_bootstrap_refuses_to_adopt_unmarked_or_elevated_objects(self):
        sql = (CHART / "files" / "ai-databases.sql").read_text()
        for guard in (
            "refusing to adopt or alter foreign/elevated AI role",
            "refusing to adopt or take ownership of foreign AI database",
            "rolbypassrls",
            "pg_auth_members",
            "greenguard.ai.database-bootstrap.v1",
        ):
            self.assertIn(guard, sql)

    def test_disabled_by_default(self):
        rendered = subprocess.run(
            ["helm", "template", "ai-db", str(CHART)],
            check=True, capture_output=True, text=True,
        ).stdout
        self.assertEqual(rendered.strip(), "")

    def test_enabled_bootstrap_is_tls_and_rds_scoped(self):
        rendered = subprocess.run(
            ["helm", "template", "ai-db", str(CHART),
             "--set", "enabled=true",
             "--set", "rdsHost=greenguard-test.abc123.us-east-1.rds.amazonaws.com",
             "--set", "rdsCIDRs={10.20.0.0/16,10.21.0.0/16}"],
            check=True, capture_output=True, text=True,
        ).stdout
        for item in (
            "greenguard_knowledge", "greenguard_advisor",
            "greenguard_advisor_checkpoint", "greenguard_ai_usage",
            "knowledge_migrator", "advisor_checkpoint_app",
            "model_gateway_usage_app", "PGSSLMODE",
            "verify-full", "greenguard.io/ai-database-bootstrap",
        ):
            self.assertIn(item, rendered)
        self.assertNotIn("CREATE ROLE knowledge_app LOGIN SUPERUSER", rendered)

    def test_rejects_public_or_non_rds_targets(self):
        for rds_host, cidrs in (
            ("public.example.net", "{0.0.0.0/0}"),
            ("greenguard-test.abc123.us-east-1.rds.amazonaws.com", "{0.0.0.0/0}"),
        ):
            result = subprocess.run(
                ["helm", "template", "ai-db", str(CHART),
                 "--set", "enabled=true", "--set", f"rdsHost={rds_host}",
                 "--set", f"rdsCIDRs={cidrs}"],
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
