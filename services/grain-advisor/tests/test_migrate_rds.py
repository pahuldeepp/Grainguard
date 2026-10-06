import unittest

from migrate_rds import validate_dsn


HOST = "greenguard-test.abc123.us-east-1.rds.amazonaws.com"
DSN = (
    "postgresql://advisor_migrator:fixture-password@"
    f"{HOST}:5432/greenguard_advisor"
    "?sslmode=verify-full&sslrootcert=%2Frds-ca%2Fca.pem&connect_timeout=5"
)


class RdsMigrationGuardTests(unittest.TestCase):
    def test_accepts_exact_disposable_owner_contract(self):
        validate_dsn(DSN, HOST)

    def test_rejects_wrong_host_user_database_tls_and_extra_parameters(self):
        for dsn in (
            DSN.replace(HOST, "attacker.example.net"),
            DSN.replace("advisor_migrator", "advisor_app"),
            DSN.replace("greenguard_advisor", "postgres"),
            DSN.replace("sslmode=verify-full", "sslmode=require"),
            DSN + "&host=attacker.example.net",
            DSN.replace(":5432/", ":5433/"),
        ):
            with self.subTest(dsn=dsn), self.assertRaises(ValueError):
                validate_dsn(dsn, HOST)

    def test_rejects_non_rds_expected_host(self):
        with self.assertRaises(ValueError):
            validate_dsn(DSN, "database.internal")


if __name__ == "__main__":
    unittest.main()
