import importlib.util
from pathlib import Path
import unittest


_path = Path(__file__).with_name("verify-migration-url.py")
_spec = importlib.util.spec_from_file_location("verify_migration_url", _path)
module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(module)


class VerifyMigrationURLTest(unittest.TestCase):
    def test_rds_url_requires_verified_tls(self):
        key = "RISK_MIGRATION_URL"
        good = "postgresql://owner:secret@db.example.test/greenguard?sslmode=verify-full&sslrootcert=%2Frds-ca%2Fca.pem"
        self.assertTrue(module.valid(key, good))
        self.assertFalse(module.valid(key, good.replace("verify-full", "disable")))
        self.assertFalse(module.valid(key, good.replace("%2Frds-ca%2Fca.pem", "%2Ftmp%2Fca.pem")))
        self.assertFalse(module.valid(key, "postgresql://owner:secret@db.example.test/"))
        self.assertFalse(module.valid(key, None))


if __name__ == "__main__":
    unittest.main()
