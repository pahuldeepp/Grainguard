"""Pure contract tests; no MySQL or Kafka required."""
import json
import unittest
from dataclasses import replace

from normalize import InvalidChange, SourceConfig, canonical_id, normalize_change

TENANT = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
CONFIG = SourceConfig("partner-one", "generation-1", "legacy-mysql", "partner_inventory", "legacy")
ROWS = {
    "inventory_sites": {"tenant_key": "partner-a", "site_id": "site-1", "name": "North"},
    "inventory_bins": {"tenant_key": "partner-a", "bin_id": "bin-1", "site_id": "site-1", "name": "Silo"},
    "inventory_devices": {"tenant_key": "partner-a", "device_id": "device-1", "site_id": "site-1", "bin_id": "bin-1", "serial_number": "SN-1", "status": "active"},
}


def encoded(payload):
    return json.dumps({"schema": None, "payload": payload}, separators=(",", ":")).encode()


def change(table="inventory_sites", *, op="r", row=None, before=None, source=None, key=None, config=CONFIG, tenant_map=None, **overrides):
    image = dict(ROWS.get(table, ROWS["inventory_sites"]) if row is None else row)
    identity_field = {"inventory_sites": "site_id", "inventory_bins": "bin_id", "inventory_devices": "device_id"}.get(table, "site_id")
    source_image = {"connector": "mysql", "name": config.connector_name, "db": config.database,
                    "table": table, "file": "mysql-bin.000001", "pos": 420, "row": 0,
                    "ts_ms": 1720000000000, "snapshot": "true" if op == "r" else "false"}
    source_image.update(source or {})
    payload = {"before": image if op == "d" else before, "after": None if op == "d" else image,
               "op": op, "ts_ms": 1720000000001, "source": source_image}
    arguments = dict(source_config=config, topic=f"{config.topic_prefix}.{config.database}.{table}",
                     partition=0, offset=42,
                     key=encoded(key if key is not None else {"tenant_key": image["tenant_key"], identity_field: image[identity_field]}),
                     value=encoded(payload), tenant_map={"partner-a": TENANT} if tenant_map is None else tenant_map)
    arguments.update(overrides)
    return normalize_change(**arguments)


class NormalizeTests(unittest.TestCase):
    def test_identity_tenant_mapping_and_references(self):
        site = change()
        self.assertEqual(site.event_id, change().event_id)
        self.assertEqual(site.payload_sha256, change().payload_sha256)
        self.assertEqual(site.entity_id, canonical_id("partner-one", TENANT, "site", "site-1"))
        self.assertNotEqual(site.entity_id, canonical_id("partner-one", OTHER, "site", "site-1"))
        self.assertNotIn("tenant_key", site.payload)
        self.assertEqual(change("inventory_bins").payload["site_id"], site.entity_id)
        self.assertEqual(change("inventory_devices", op="c").payload["bin_id"], change("inventory_bins").entity_id)
        self.assertEqual(site.source_coordinate.connector_generation, "generation-1")
        self.assertEqual(site.source_coordinate.offset, 42)

    def test_unmapped_and_spoofed_tenant_rejected(self):
        with self.assertRaises(InvalidChange):
            change(tenant_map={})
        with self.assertRaises(InvalidChange):
            change(tenant_map={"partner-a": "bad"})
        with self.assertRaises(InvalidChange):
            change(key={"tenant_key": "partner-b", "site_id": "site-1"})
        with self.assertRaises(InvalidChange):
            change(row={**ROWS["inventory_sites"], "tenant_id": OTHER})
        with self.assertRaises(InvalidChange):
            change(key={"tenant_key": "partner-a", "site_id": "site-1", "tenant_id": OTHER})

    def test_source_allowlist_topic_and_coordinates(self):
        for kwargs in (
            {"table": "users"},
            {"topic": "legacy.partner_inventory.inventory_bins"},
            {"source": {"name": "other"}},
            {"source": {"file": None}},
            {"source": {"pos": None}},
            {"offset": -1},
            {"partition": True},
            {"offset": 2**63},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(InvalidChange):
                change(**kwargs)

    def test_malformed_and_oversized_envelopes(self):
        for value in (b"", b"null", b"{}", b'{"payload":{}}', b'{"schema":null,"payload":{},"payload":{}}', b"x" * 65537, b"\xff"):
            with self.subTest(value=value[:20]), self.assertRaises(InvalidChange):
                change(value=value)
        for row in (
            {**ROWS["inventory_sites"], "site_id": "x" * 129},
            {**ROWS["inventory_sites"], "name": "x" * 201},
            {**ROWS["inventory_sites"], "extra": "no"},
        ):
            with self.subTest(row=row), self.assertRaises(InvalidChange):
                change(row=row)
        with self.assertRaises(InvalidChange):
            change("inventory_devices", row={**ROWS["inventory_devices"], "status": "provisioning"})

    def test_operations_and_delete_before_image(self):
        self.assertEqual(change(op="d").operation, "delete")
        self.assertEqual(change("inventory_devices", op="d").payload["device_id"], change("inventory_devices").entity_id)
        self.assertEqual(change("inventory_bins", op="d").payload["bin_id"], change("inventory_bins").entity_id)
        for kwargs in (
            {"op": "x"}, {"source": {"snapshot": "false"}},
            {"op": "c", "source": {"snapshot": "true"}},
            {"op": "u", "before": {**ROWS["inventory_sites"], "site_id": "old"}},
            {"table": "inventory_bins", "op": "u", "before": ROWS["inventory_bins"],
             "row": {**ROWS["inventory_bins"], "site_id": "site-2"}},
            {"op": "c", "before": ROWS["inventory_sites"]},
            {"op": "d", "row": {**ROWS["inventory_sites"], "extra": "no"}},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(InvalidChange):
                change(**kwargs)

    def test_digest_fences_same_coordinate_content_change(self):
        first = change()
        changed = change(row={**ROWS["inventory_sites"], "name": "South"})
        self.assertEqual(first.event_id, changed.event_id)
        self.assertNotEqual(first.payload_sha256, changed.payload_sha256)
        self.assertNotEqual(first.event_id, change(offset=43).event_id)
        self.assertNotEqual(first.event_id, change(config=replace(CONFIG, connector_generation="generation-2")).event_id)

    def test_debezium_three_snapshot_markers_are_accepted_only_for_reads(self):
        for marker in ("first", "first_in_data_collection", "last_in_data_collection", "last"):
            with self.subTest(marker=marker):
                self.assertEqual(change(source={"snapshot": marker}).operation, "upsert")
                with self.assertRaises(InvalidChange):
                    change(op="c", source={"snapshot": marker})


if __name__ == "__main__":
    unittest.main()
