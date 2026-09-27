"""Source schema invariants required for safe tenant-scoped CDC."""
import unittest

from sqlalchemy import CheckConstraint, ForeignKeyConstraint, PrimaryKeyConstraint, UniqueConstraint
from source_schema import metadata


class SourceSchemaTests(unittest.TestCase):
    def test_only_three_tenant_scoped_inventory_tables(self):
        self.assertEqual(set(metadata.tables), {"inventory_sites", "inventory_bins", "inventory_devices"})
        for table in metadata.tables.values():
            primary_key = next(c for c in table.constraints if isinstance(c, PrimaryKeyConstraint))
            self.assertIn("tenant_key", primary_key.columns)
            self.assertFalse(table.c.tenant_key.nullable)

    def test_references_are_tenant_scoped_and_non_cascading(self):
        bins = metadata.tables["inventory_bins"]
        devices = metadata.tables["inventory_devices"]
        self.assertTrue(any(isinstance(c, UniqueConstraint) and set(c.columns.keys()) == {"tenant_key", "site_id", "bin_id"} for c in bins.constraints))
        for table in (bins, devices):
            for constraint in table.constraints:
                if isinstance(constraint, ForeignKeyConstraint):
                    self.assertIn("tenant_key", constraint.columns)
                    self.assertEqual(constraint.ondelete, "RESTRICT")
        self.assertTrue(devices.c.bin_id.nullable)

    def test_text_constraints_match_normalizer_control_and_edge_space_rules(self):
        for table, column in (("inventory_sites", "name"), ("inventory_bins", "name"), ("inventory_devices", "serial_number")):
            checks = [str(c.sqltext) for c in metadata.tables[table].constraints if isinstance(c, CheckConstraint)]
            text_check = next(check for check in checks if column in check)
            self.assertIn(f"char_length({column}) = char_length(TRIM({column}))", text_check)
            self.assertIn("[[:cntrl:]]", text_check)


if __name__ == "__main__":
    unittest.main()
