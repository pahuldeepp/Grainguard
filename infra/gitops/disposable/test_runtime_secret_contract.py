"""Offline source contract for the Terraform Secret lifecycle graph."""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "terraform" / "disposable"


class TerraformSecretContractTests(unittest.TestCase):
    def test_migrations_cover_exact_38_authorities(self):
        template = Path(__file__).parent / "applications-chart/templates/_owner-migrations.tpl"
        owners = json.loads(re.search(r"fromJsonArray `([^`]+)`", template.read_text()).group(1))
        self.assertEqual(len(owners), 11)
        self.assertEqual({row["name"] for row in owners if row["central"]}, {"control", "billing"})
        self.assertEqual(sum(1 if row["central"] else 4 for row in owners), 38)
        for row in owners:
            self.assertEqual(row["migrator"], row["name"] + "_migrator")
            self.assertEqual(row["key"], row["name"].upper() + "_MIGRATION_URL")

    def test_incarnation_uses_immutable_resource_not_reusable_name(self):
        source = (ROOT / "shard-secret-values.tf").read_text()
        expression = re.search(r"shard_incarnations\s*=([^\n]+)", source).group(1)
        self.assertIn('uuidv5("url"', expression)
        self.assertIn("shard.resource_id", expression)
        self.assertNotIn("shard.identifier", expression)
        self.assertNotIn("random_uuid", source)

    def test_cleanup_survives_failed_sync_taint(self):
        source = (ROOT / "runtime-secrets.tf").read_text()
        cleanup = source.split('resource "terraform_data" "runtime_secret_cleanup" {', 1)[1]
        sync = source.split('resource "terraform_data" "runtime_secret_sync" {', 1)[1].split('# RDS rotates', 1)[0]
        self.assertEqual(cleanup.count('provisioner "local-exec"'), 1)
        self.assertRegex(cleanup, r"when\s*=\s*destroy")
        self.assertNotRegex(sync, r"when\s*=\s*destroy")
        self.assertIn("terraform_data.runtime_secret_cleanup", sync)
        self.assertIn("helm_release.greenguard_namespace", cleanup)
        self.assertNotIn("create_before_destroy", source)

    def test_password_inputs_are_sensitive(self):
        for file, variables in (("runtime-secrets.tf", ["runtime_secret_values"]),
                                ("shard-secret-values.tf", ["shard_role_passwords", "shard_registry_passwords"])):
            source = (ROOT / file).read_text()
            for variable in variables:
                body = source.split(f'variable "{variable}" {{', 1)[1].split('\n}', 1)[0]
                self.assertRegex(body, r"sensitive\s*=\s*true")


if __name__ == "__main__":
    unittest.main()
