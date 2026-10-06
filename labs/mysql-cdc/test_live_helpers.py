"""Regression checks for the live profile's URL and migration boundaries."""
import importlib.util
import io
import ast
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import Column, Constraint

from live_test import run_cleanup_steps, source_dsn
from source_schema import metadata
from setup_local import TOPICS


class LiveHelpersTests(unittest.TestCase):
    def test_cleanup_continues_after_each_failure_and_preserves_primary(self):
        visited = []
        def broken():
            visited.append("connector")
            raise ValueError("tenant@example.test secret")
        steps = [("connector", broken), ("postgres_fixtures", lambda: visited.append("postgres")),
                 ("kafka_topics", lambda: visited.append("kafka")),
                 ("mysql_database", lambda: visited.append("mysql"))]
        diagnostics = io.StringIO()
        with redirect_stderr(diagnostics):
            self.assertEqual(run_cleanup_steps(steps, primary_failed=True), ["connector"])
        self.assertEqual(visited, ["connector", "postgres", "kafka", "mysql"])
        self.assertIn("CLEANUP_FAILURE step=connector error=ValueError", diagnostics.getvalue())
        self.assertNotIn("tenant@example.test", diagnostics.getvalue())
        with redirect_stderr(io.StringIO()), self.assertRaisesRegex(RuntimeError, "connector"):
            run_cleanup_steps(steps, primary_failed=False)

    def test_password_is_encoded_as_one_url_component(self):
        self.assertIn("partner_cdc:p%40ss%3A%2F%25word@", source_dsn("gglive_test", "p@ss:/%word"))

    def test_migration_passes_new_unbound_elements(self):
        path = Path(__file__).parent / "migrations/versions/0001_inventory_source.py"
        imports = [node.module for node in ast.walk(ast.parse(path.read_text()))
                   if isinstance(node, ast.ImportFrom)]
        self.assertNotIn("source_schema", imports)
        spec = importlib.util.spec_from_file_location("mysql_cdc_initial_migration", path)
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        calls = []
        with patch.object(migration.op, "create_table", side_effect=lambda name, *elements: calls.append((name, elements))):
            migration.upgrade()
        self.assertEqual([name for name, _ in calls], list(metadata.tables))
        for name, elements in calls:
            source = metadata.tables[name]
            columns = [element for element in elements if isinstance(element, Column)]
            constraints = [element for element in elements if isinstance(element, Constraint)]
            self.assertEqual([column.name for column in columns], list(source.columns.keys()))
            self.assertTrue(all(column.table is None and column is not source.columns[column.name] for column in columns))
            self.assertEqual(len(constraints), len(source.constraints))
            self.assertTrue(all(constraint not in source.constraints for constraint in constraints))

    def test_edge_space_revision_matches_current_checks_and_park_retention(self):
        path = Path(__file__).parent / "migrations/versions/0002_edge_space_checks.py"
        spec = importlib.util.spec_from_file_location("mysql_cdc_edge_checks", path)
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        self.assertEqual(migration.down_revision, "0001_inventory_source")
        for table, name, column, maximum in migration.CHECKS:
            model = next(c for c in metadata.tables[table].constraints if c.name == name)
            self.assertEqual(str(model.sqltext), migration.check_sql(column, maximum, strict=True))
        self.assertEqual(TOPICS["greenguard.mysql-cdc.parked.v1"], ("delete", -1))


if __name__ == "__main__":
    unittest.main()
