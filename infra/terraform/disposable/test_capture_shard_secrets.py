"""Validate physical ownership independently of retained read-only secret history."""
import importlib.util
import json
import subprocess
from pathlib import Path
import unittest

SCRIPT = Path(__file__).with_name("capture-shard-secrets.py")
spec = importlib.util.spec_from_file_location("capture_shard_secrets", SCRIPT)
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


def arn(name, region="us-east-1", account="123456789012"):
    return f"arn:aws:secretsmanager:{region}:{account}:secret:rds!{name}"


def outputs(generation="old"):
    return {"postgres_shards": {"value": {f"s{i}": {"master_secret_arn": arn(f"{generation}-s{i}")} for i in range(1, 5)}}}


def resource(shard="s1", generation="new"):
    return {"address": f'aws_db_instance.shard["{shard}"]', "mode": "managed", "type": "aws_db_instance", "name": "shard", "index": shard,
            "values": {"master_user_secret": [{"secret_arn": arn(f"{generation}-{shard}")}]}}


def state(resources):
    return {"values": {"root_module": {"resources": resources}}}


class PhysicalShardCaptureTests(unittest.TestCase):
    def test_stale_four_outputs_and_one_current_secret_are_both_retained(self):
        captured = capture.capture(outputs(), state([resource("s2")]), "us-east-1", "123456789012")
        self.assertEqual(captured, [arn(f"old-s{i}") for i in range(1, 5)] + [arn("new-s2")])

    def test_all_four_replaced_secrets_are_retained(self):
        captured = capture.capture(outputs(), state([resource(f"s{i}") for i in range(1, 5)]), "us-east-1", "123456789012")
        self.assertEqual(captured, [arn(f"old-s{i}") for i in range(1, 5)] + [arn(f"new-s{i}") for i in range(1, 5)])

    def test_same_secrets_in_both_sources_are_deduplicated(self):
        self.assertEqual(capture.capture(outputs(), state([resource(f"s{i}", "old") for i in range(1, 5)]), "us-east-1", "123456789012"),
                         [arn(f"old-s{i}") for i in range(1, 5)])

    def test_partial_capture_has_no_fabricated_shards(self):
        self.assertEqual(capture.capture({}, state([resource("s2")]), "us-east-1", "123456789012"), [arn("new-s2")])
        self.assertEqual(capture.capture({}, {}, "us-east-1", "123456789012"), [])

    def test_invalid_indices_cardinality_and_duplicate_physical_shards_fail(self):
        wrong_index = resource(); wrong_index["index"] = "s2"
        bad_name = resource(); bad_name["name"] = "neighbor"
        bad_type = resource(); bad_type["type"] = "aws_unowned"
        foreign_module = resource(); foreign_module["address"] = 'module.other.aws_db_instance.shard["s1"]'
        for resources in ([resource("s5")], [wrong_index], [resource(), resource()], [bad_name], [bad_type], [foreign_module],
                          [resource(f"s{i}") for i in range(1, 6)]):
            with self.subTest(resources=resources), self.assertRaises(ValueError):
                capture.capture({}, state(resources), "us-east-1", "123456789012")

    def test_duplicated_secret_across_different_physical_shards_fails(self):
        duplicate = resource("s2"); duplicate["values"]["master_user_secret"][0]["secret_arn"] = arn("new-s1")
        with self.assertRaisesRegex(ValueError, "duplicate secret"):
            capture.capture({}, state([resource(), duplicate]), "us-east-1", "123456789012")
        duplicate_outputs = outputs(); duplicate_outputs["postgres_shards"]["value"]["s2"] = duplicate_outputs["postgres_shards"]["value"]["s1"]
        with self.assertRaisesRegex(ValueError, "duplicate secret"):
            capture.capture(duplicate_outputs, {}, "us-east-1", "123456789012")

    def test_foreign_regions_accounts_and_non_rds_secrets_fail(self):
        for secret in (arn("s1", account="999999999999"), arn("s1", region="us-west-2"),
                       "arn:aws:secretsmanager:us-east-1:123456789012:secret:neighbor", arn("s1") + "\nextra"):
            bad = resource(); bad["values"]["master_user_secret"][0]["secret_arn"] = secret
            with self.subTest(secret=secret), self.assertRaisesRegex(ValueError, "account/region or RDS"):
                capture.capture({}, state([bad]), "us-east-1", "123456789012")

    def test_unrelated_secret_resource_named_shard_is_not_a_database(self):
        unrelated = {"address": 'aws_secretsmanager_secret.shard["s1"]', "mode": "managed", "type": "aws_secretsmanager_secret", "name": "shard", "values": {}}
        self.assertEqual(capture.capture({}, state([unrelated]), "us-east-1", "123456789012"), [])

    def test_duplicate_json_fields_cannot_hide_a_physical_shard(self):
        result = subprocess.run(["python3", str(SCRIPT), "us-east-1", "123456789012"],
                                input='{}\n{"values":{"root_module":{},"root_module":{}}}', capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate JSON object key", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_invalid_registry_and_unavailable_secrets_fail(self):
        bad_registry = outputs(); bad_registry["postgres_shards"]["value"]["s5"] = {"master_secret_arn": arn("old-s5")}
        missing = resource(); missing["values"]["master_user_secret"] = []
        for registry, current in ((bad_registry, {}), ({"postgres_shards": None}, {}), ({}, state([missing])), ({}, state([{}]) | {"values": []})):
            with self.subTest(registry=registry, state=current), self.assertRaises(ValueError):
                capture.capture(registry, current, "us-east-1", "123456789012")


if __name__ == "__main__":
    unittest.main()
