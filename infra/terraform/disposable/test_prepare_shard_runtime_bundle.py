import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("shard_bundle", Path(__file__).with_name("prepare-shard-runtime-bundle.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ShardBundleTests(unittest.TestCase):
    def test_four_shards_have_independent_credentials_and_exact_service_roles(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bundle.json"
            module.prepare(path)
            original = path.read_bytes()
            payload = json.loads(original)
            keys, profiles = module.contracts()
            self.assertEqual(len(profiles), 11)
            self.assertNotIn("CONTROL_DB_PASSWORD", keys)
            self.assertNotIn("BILLING_DB_PASSWORD", keys)
            self.assertNotIn("DEX_DB_PASSWORD", keys)
            for shard in module.SHARDS:
                self.assertEqual(set(payload["shard_role_passwords"][shard]), keys)
                for service, key in profiles.items():
                    self.assertEqual(payload["shard_registry_passwords"][service][shard], payload["shard_role_passwords"][shard][key])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            all_passwords = [password for shard in payload["shard_role_passwords"].values() for password in shard.values()] + list(payload["tenant_bootstrap_passwords"].values())
            self.assertEqual(len(all_passwords), len(set(all_passwords)))
            self.assertTrue(all(len(password) >= 32 for password in all_passwords))
            module.prepare(path)
            self.assertEqual(path.read_bytes(), original)

    def test_reused_shard_password_and_central_role_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bundle.json"
            module.prepare(path)
            original = json.loads(path.read_text())
            for mutation in ("duplicate", "central"):
                payload = json.loads(json.dumps(original))
                if mutation == "duplicate":
                    payload["shard_role_passwords"]["s2"]["CDC_DB_PASSWORD"] = payload["shard_role_passwords"]["s1"]["CDC_DB_PASSWORD"]
                else:
                    payload["shard_role_passwords"]["s1"]["CONTROL_DB_PASSWORD"] = "unexpected-central-password-0123456789"
                path.write_text(json.dumps(payload))
                with self.assertRaises(ValueError):
                    module.prepare(path)

    def test_mismatched_registry_is_rejected_without_rotation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bundle.json"
            module.prepare(path)
            payload = json.loads(path.read_text())
            payload["shard_registry_passwords"]["read-api"]["s1"] = "wrong-role-password"
            path.write_text(json.dumps(payload))
            original = path.read_bytes()
            with self.assertRaises(ValueError):
                module.prepare(path)
            self.assertEqual(path.read_bytes(), original)

    def test_public_file_and_symbolic_link_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bundle.json"
            module.prepare(path)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                module.prepare(path)
            path.chmod(0o600)
            link = Path(directory) / "link.json"
            link.symlink_to(path)
            with self.assertRaises(ValueError):
                module.prepare(link)


if __name__ == "__main__":
    unittest.main()
