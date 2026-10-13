"""Fail before any DDL/grant when the connected role bypasses tenant isolation."""
import unittest
from unittest.mock import MagicMock, patch
import migrate_cluster

class MigratorRoleTests(unittest.TestCase):
    def test_privileged_or_missing_role_is_rejected_before_mutation(self):
        for flags in ((True, False), (False, True), None):
            db = MagicMock()
            db.execute.return_value.fetchone.return_value = flags
            db.__enter__.return_value = db
            with self.subTest(flags=flags), patch.dict(migrate_cluster.os.environ, {"ML_ENVIRONMENT":"cluster-synthetic", "ML_MIGRATION_DATABASE_URL":"fixture"}), patch.object(migrate_cluster, '_validated_dsn'), patch.object(migrate_cluster.psycopg, 'connect', return_value=db), patch.object(migrate_cluster, '_apply_migrations') as apply, patch.object(migrate_cluster, '_grant_runtime_access') as grant:
                with self.assertRaises(RuntimeError): migrate_cluster.main()
                apply.assert_not_called()
                grant.assert_not_called()

    def test_safe_role_runs_migrations_then_grants(self):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = (False, False)
        db.__enter__.return_value = db
        events = []
        with patch.dict(migrate_cluster.os.environ, {"ML_ENVIRONMENT":"cluster-synthetic", "ML_MIGRATION_DATABASE_URL":"fixture"}), patch.object(migrate_cluster, '_validated_dsn'), patch.object(migrate_cluster.psycopg, 'connect', return_value=db), patch.object(migrate_cluster, '_apply_migrations', side_effect=lambda _: events.append('apply')), patch.object(migrate_cluster, '_grant_runtime_access', side_effect=lambda _: events.append('grant')):
            migrate_cluster.main()
        self.assertEqual(events, ['apply', 'grant'])

if __name__ == '__main__': unittest.main()
