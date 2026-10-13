import importlib.util
import json
import os
import stat
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

SCRIPT = Path(__file__).with_name("destroy-scope-manifest.py")
spec = importlib.util.spec_from_file_location("destroy_scope_manifest", SCRIPT)
manifest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manifest)


class DestroyScopeManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "scope.json"
        self.document = {
            "schema": 1, "region": "us-east-1", "environment": "sandbox",
            "cluster_name": "greenguard-sandbox-cell-1", "account_id": "123456789012",
            "master_secret_arn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:primary",
            "shard_master_secret_arns": [
                f"arn:aws:secretsmanager:us-east-1:123456789012:secret:s{i}" for i in range(1, 5)
            ],
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_saves_private_manifest_and_reads_exact_scope(self):
        manifest.save(self.path, self.document)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(manifest.read_manifest(self.path), self.document)

    def test_idempotent_save_keeps_same_scope_and_rejects_other_scope(self):
        manifest.save(self.path, self.document)
        manifest.save(self.path, self.document)
        altered = dict(self.document, cluster_name="another-cell")
        with self.assertRaisesRegex(ValueError, "different cell"):
            manifest.save(self.path, altered)

    def test_partial_destroy_save_merges_secret_arns_instead_of_forgetting_deleted_state(self):
        manifest.save(self.path, self.document)
        partial = dict(self.document, master_secret_arn="", shard_master_secret_arns=self.document["shard_master_secret_arns"][:2])
        manifest.save(self.path, partial)
        self.assertEqual(manifest.read_manifest(self.path), self.document)

    def test_retains_all_four_replacements_and_multiple_retry_generations(self):
        manifest.save(self.path, self.document)
        expected = list(self.document["shard_master_secret_arns"])
        for generation in ("replacement", "retry"):
            incoming = [f"arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!{generation}-s{i}" for i in range(1, 5)]
            manifest.save(self.path, dict(self.document, shard_master_secret_arns=incoming))
            expected += incoming
            self.assertEqual(manifest.read_manifest(self.path)["shard_master_secret_arns"], expected)
            self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        # Partial native retries must preserve every generation already saved.
        environment = {"GG_REGION": "us-east-1", "GG_ENVIRONMENT": "sandbox",
                       "GG_CLUSTER": self.document["cluster_name"], "GG_ACCOUNT": "123456789012",
                       "GG_MASTER_SECRET_ARN": "", "GG_SHARD_MASTER_SECRET_ARNS": "[]"}
        with patch.dict(os.environ, environment):
            manifest.main([str(SCRIPT), "save-env", str(self.path)])
        reopened = manifest.read_manifest(self.path)
        self.assertEqual(reopened["shard_master_secret_arns"], expected)
        self.assertEqual(reopened["master_secret_arn"], self.document["master_secret_arn"])

    def test_one_current_rotation_merges_with_four_stale_arns(self):
        manifest.save(self.path, self.document)
        current = "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!new-s2"
        manifest.save(self.path, dict(self.document, shard_master_secret_arns=[current]))
        self.assertEqual(manifest.read_manifest(self.path)["shard_master_secret_arns"], self.document["shard_master_secret_arns"] + [current])

    def test_invalid_secret_history_preserves_the_durable_manifest(self):
        manifest.save(self.path, self.document)
        original = self.path.read_bytes()
        for inventory in ([self.document["shard_master_secret_arns"][0]] * 2,
                          ["arn:aws:secretsmanager:us-west-2:123456789012:secret:rds!foreign"],
                          ["arn:aws:secretsmanager:us-east-1:999999999999:secret:rds!foreign"],
                          ["arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!new extra"],
                          [None]):
            with self.subTest(inventory=inventory), self.assertRaises(ValueError):
                manifest.save(self.path, dict(self.document, shard_master_secret_arns=inventory))
            self.assertEqual(self.path.read_bytes(), original)

    def test_new_primary_identity_cannot_replace_recorded_identity(self):
        manifest.save(self.path, self.document)
        original = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "different primary"):
            manifest.save(self.path, dict(self.document, master_secret_arn="arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!neighbor"))
        self.assertEqual(self.path.read_bytes(), original)

    def test_native_current_physical_inventory_still_rejects_more_than_four(self):
        environment = {"GG_REGION": "us-east-1", "GG_ENVIRONMENT": "sandbox",
                       "GG_CLUSTER": self.document["cluster_name"], "GG_ACCOUNT": "123456789012",
                       "GG_MASTER_SECRET_ARN": "", "GG_SHARD_MASTER_SECRET_ARNS": json.dumps([
                           f"arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!s{i}" for i in range(1, 6)])}
        with patch.dict(os.environ, environment), self.assertRaisesRegex(ValueError, "physical shard inventory"):
            manifest.main([str(SCRIPT), "save-env", str(self.path)])
        self.assertFalse(self.path.exists())

    def test_failed_atomic_replace_preserves_old_manifest_and_removes_temporary(self):
        manifest.save(self.path, self.document)
        original = self.path.read_bytes()
        with patch.object(manifest.os, "replace", side_effect=OSError("injected replace failure")), self.assertRaises(OSError):
            manifest.save(self.path, dict(self.document, shard_master_secret_arns=["arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!new"]))
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(list(self.path.parent.glob(".destroy-scope-*")), [])

    def test_rejects_wrong_owner_file_mode_and_symlink(self):
        self.path.write_text(json.dumps(self.document))
        self.path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "mode-0600"):
            manifest.read_manifest(self.path)
        self.path.unlink()
        target = Path(self.temp.name) / "target.json"
        target.write_text(json.dumps(self.document))
        target.chmod(0o600)
        self.path.symlink_to(target)
        with self.assertRaises(OSError):
            manifest.read_manifest(self.path)

    def test_rejects_production_and_foreign_secret_arns(self):
        with self.assertRaisesRegex(ValueError, "scope is invalid"):
            manifest.validate_document(dict(self.document, environment="production"))
        foreign = dict(self.document, master_secret_arn="arn:aws:secretsmanager:us-west-2:123456789012:secret:primary")
        with self.assertRaisesRegex(ValueError, "secret ARN scope"):
            manifest.validate_document(foreign)

    def test_duplicate_json_fields_cannot_override_saved_identity(self):
        payload = json.dumps(self.document).replace('"account_id": "123456789012"', '"account_id": "999999999999", "account_id": "123456789012"')
        self.path.write_text(payload)
        self.path.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "duplicate JSON"):
            manifest.read_manifest(self.path)

    def test_remove_only_after_callers_successful_inventory(self):
        manifest.save(self.path, self.document)
        manifest.main([str(SCRIPT), "remove", str(self.path)])
        self.assertFalse(self.path.exists())

    def test_native_destroy_save_env_merges_shard_inventory_for_retry(self):
        manifest.save(self.path, self.document)
        environment = {
            "GG_REGION": "us-east-1",
            "GG_ENVIRONMENT": "sandbox",
            "GG_CLUSTER": "greenguard-sandbox-cell-1",
            "GG_ACCOUNT": "123456789012",
            "GG_MASTER_SECRET_ARN": self.document["master_secret_arn"],
            "GG_SHARD_MASTER_SECRET_ARNS": json.dumps(self.document["shard_master_secret_arns"][:2]),
        }
        with patch.dict(os.environ, environment):
            manifest.main([str(SCRIPT), "save-env", str(self.path)])
        self.assertEqual(manifest.read_manifest(self.path), self.document)

    def test_native_destroy_save_env_rejects_invalid_shard_json(self):
        with patch.dict(os.environ, {"GG_SHARD_MASTER_SECRET_ARNS": "not-json"}):
            with self.assertRaisesRegex(ValueError, "not valid JSON"):
                manifest.main([str(SCRIPT), "save-env", str(self.path)])


if __name__ == "__main__":
    unittest.main()
