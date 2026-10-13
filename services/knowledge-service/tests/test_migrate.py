import unittest

from migrate import validate_local_dsn
from migrate_rds import validate_dsn


RDS_HOST = "greenguard-test.abc123.us-east-1.rds.amazonaws.com"
RDS_DSN = (
    "postgresql://knowledge_migrator:fixture-password@"
    f"{RDS_HOST}:5432/greenguard_knowledge"
    "?sslmode=verify-full&sslrootcert=%2Frds-ca%2Fca.pem&connect_timeout=5"
)


class MigrationGuardTests(unittest.TestCase):
    def test_only_local_knowledge_database_is_allowed(self):
        for host in ("localhost", "127.0.0.1", "[::1]"):
            validate_local_dsn(f"postgresql://user:secret@{host}:5432/greenguard_knowledge")
        for dsn in (
            "postgresql://user:secret@db.internal:5432/greenguard_knowledge",
            "postgresql://user:secret@localhost:5432/postgres",
            "postgresql://user:secret@localhost:5432/greenguard_knowledge?host=db.internal",
            "postgresql://user:secret@localhost:5432/greenguard_knowledge?dbname=prod",
            "postgresql://user:secret@/greenguard_knowledge",
        ):
            with self.subTest(dsn=dsn), self.assertRaises(ValueError):
                validate_local_dsn(dsn)

    def test_rds_migration_dsn_requires_exact_owner_tls_contract(self):
        validate_dsn(RDS_DSN, RDS_HOST)

    def test_rds_migration_rejects_wrong_host_owner_database_or_tls(self):
        invalid = (
            RDS_DSN.replace(RDS_HOST, "attacker.example.net"),
            RDS_DSN.replace("knowledge_migrator", "knowledge_app"),
            RDS_DSN.replace("greenguard_knowledge", "postgres"),
            RDS_DSN.replace("sslmode=verify-full", "sslmode=require"),
            RDS_DSN + "&options=-csearch_path=public",
            RDS_DSN.replace(":5432/", ":5433/"),
        )
        for dsn in invalid:
            with self.subTest(dsn=dsn), self.assertRaises(ValueError):
                validate_dsn(dsn, RDS_HOST)

    def test_rds_migration_rejects_non_disposable_expected_host(self):
        with self.assertRaises(ValueError):
            validate_dsn(RDS_DSN, "database.internal")


if __name__ == "__main__":
    unittest.main()
