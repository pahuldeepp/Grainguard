import io
import os
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from risk_engine import migrate
from risk_engine.store import PgDatabase, StoreError, classify


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, applied):
        self.applied, self.statements = dict(applied), []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, statement, params=()):
        self.statements.append(statement)
        if statement.startswith("INSERT INTO schema_migrations"):
            self.applied[params[0]] = params[1]
        return FakeCursor(list(self.applied.items()))

    def transaction(self):
        return self


class MigrateTest(unittest.TestCase):
    def write(self, directory, name, body="SELECT 1;"):
        (Path(directory) / name).write_text(body, encoding="utf-8")

    def test_applies_in_order_once_and_rejects_modified_history(self):
        with tempfile.TemporaryDirectory() as directory:
            self.write(directory, "000002_b.up.sql")
            self.write(directory, "000001_a.up.sql")
            conn = FakeConnection({})
            self.assertEqual(migrate.migrate("url", Path(directory), lambda url: conn), ["000001", "000002"])
            self.assertEqual(migrate.migrate("url", Path(directory), lambda url: conn), [])
            self.write(directory, "000001_a.up.sql", "SELECT 2;")
            with self.assertRaisesRegex(migrate.MigrationError, "modified"):
                migrate.migrate("url", Path(directory), lambda url: conn)

    def test_rejects_duplicate_versions_and_bad_names(self):
        with tempfile.TemporaryDirectory() as directory:
            self.write(directory, "000001_a.up.sql")
            self.write(directory, "000001_b.up.sql")
            with self.assertRaisesRegex(migrate.MigrationError, "duplicate"):
                migrate.discover(Path(directory))
        with tempfile.TemporaryDirectory() as directory:
            self.write(directory, "1_a.sql")
            with self.assertRaisesRegex(migrate.MigrationError, "unexpected"):
                migrate.discover(Path(directory))

    def test_repository_migrations_are_forward_only_and_named(self):
        plan = migrate.discover()
        self.assertEqual(plan[0][0], "000001")
        self.assertFalse(list(migrate.MIGRATIONS.glob("*.down.sql")))

    def test_main(self):
        out = io.StringIO()
        self.assertEqual(migrate.main({}.get, out=out), 2)
        self.assertEqual(migrate.main({"RISK_MIGRATION_URL": "u"}.get, run=lambda url: [], out=out), 0)
        self.assertEqual(migrate.main({"RISK_MIGRATION_URL": "u"}.get, run=lambda url: ["000001"], out=out), 0)
        self.assertIn("000001", out.getvalue())

    @unittest.skipUnless(os.environ.get("RISK_MIGRATION_URL"), "live risk database not configured")
    def test_live_entry_point_is_idempotent(self):
        out = io.StringIO()
        with mock.patch.object(sys, "stdout", out), self.assertRaises(SystemExit) as done:
            runpy.run_module("risk_engine.migrate", run_name="__main__")
        self.assertEqual(done.exception.code, 0)
        self.assertIn("up to date", out.getvalue())


class ClassifyTest(unittest.TestCase):
    def test_sqlstate_classes(self):
        cases = {None: "transient", "40001": "transient", "40P01": "transient", "08006": "transient",
                 "53300": "transient", "57014": "transient", "42501": "hard", "23505": "rejected",
                 "22P02": "rejected", "XX000": "hard", "42P01": "hard"}
        for state, kind in cases.items():
            with self.subTest(state=state):
                self.assertEqual(classify(StoreError(state, "x")), kind)


class Boom(Exception):
    sqlstate = None


class PgDatabaseUnitTest(unittest.TestCase):
    def test_connection_loss_closes_and_reconnects(self):
        opened = []

        class Conn:
            closed = False

            def execute(self, *args):
                raise Boom("server closed the connection")

            def close(self):
                self.closed = True

        def connect(url):
            opened.append(Conn())
            return opened[-1]

        db = PgDatabase("u", connect=connect, driver_error=lambda: Boom)
        self.assertFalse(db.ping())
        self.assertTrue(opened[0].closed)
        with self.assertRaises(StoreError):
            db.quarantine("c", "t", 0, 1, "r", "0" * 64)
        self.assertEqual(len(opened), 2)
        db.close()
        PgDatabase("u").close()


if __name__ == "__main__":
    unittest.main()
