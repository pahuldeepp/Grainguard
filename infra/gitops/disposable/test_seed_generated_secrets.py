import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch


PATH = Path(__file__).with_name("seed-generated-secrets.py")
SPEC = importlib.util.spec_from_file_location("seed_generated_secrets", PATH)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)
ACCOUNT = "123456789012"
REGION = "us-east-1"
ENV = "disposable"
FLAGS = ["--account-id", ACCOUNT, "--region", REGION, "--environment", ENV]


class SeedTests(unittest.TestCase):
    def setUp(self):
        self.values = {}

    def response(self, *args, payload=None):
        if args[0] == "sts":
            return {"Account": ACCOUNT}
        if args[1] == "describe-secret":
            name = args[args.index("--secret-id") + 1]
            return {"Name": name, "ARN": f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:{name}-abc",
                    "VersionIdsToStages": {"version": ["AWSCURRENT"]} if name in self.values else {}}
        if args[1] == "get-secret-value":
            arn = args[args.index("--secret-id") + 1]
            name = arn.split(":secret:", 1)[1].removesuffix("-abc")
            return {"Name": name, "VersionId": "version", "VersionStages": ["AWSCURRENT"],
                    "SecretString": json.dumps(self.values[name])}
        if args[1] == "put-secret-value":
            self.assertEqual(args[args.index("--secret-string") + 1], "file:///dev/stdin")
            data = json.loads(payload)
            self.assertTrue(all(data.values()))
            self.assertNotIn("password", " ".join(args).lower())
            arn = args[args.index("--secret-id") + 1]
            name = arn.split(":secret:", 1)[1].removesuffix("-abc")
            self.values[name] = data
            return {"VersionId": "new"}
        raise AssertionError(args)

    def test_plan_never_generates_or_writes(self):
        with patch.object(MOD, "aws", side_effect=self.response) as client, patch.object(MOD, "generated") as generated:
            self.assertEqual(MOD.main(FLAGS), 1)
            generated.assert_not_called()
            self.assertEqual(sum(c.args[1] == "put-secret-value" for c in client.call_args_list), 0)

    def test_apply_creates_only_missing_sources(self):
        with patch.object(MOD, "aws", side_effect=self.response) as client:
            self.assertEqual(MOD.main(FLAGS + ["--apply"]), 0)
            puts = [c for c in client.call_args_list if c.args[1] == "put-secret-value"]
            self.assertEqual(len(puts), 5)
            roles = json.loads(puts[0].kwargs["payload"])
            self.assertEqual(set(roles), set(MOD.role_keys()))
            self.assertEqual(set(json.loads(puts[1].kwargs["payload"])),
                             {"GF_SECURITY_ADMIN_USER", "GF_SECURITY_ADMIN_PASSWORD"})
            self.assertEqual(json.loads(puts[2].kwargs["payload"]),
                             {"CDC_DB_PASSWORD": roles["CDC_DB_PASSWORD"]})
            self.assertEqual(set(json.loads(puts[3].kwargs["payload"])), {"password"})
            self.assertEqual(set(json.loads(puts[4].kwargs["payload"])),
                             {"writer-password", "reader-password", "acceptance-writer-password", "acceptance-reader-password"})

    def test_existing_current_is_not_rotated(self):
        roles = MOD.generated("greenguard-rds-bootstrap")
        self.values = {f"greenguard/{ENV}/greenguard-rds-bootstrap": roles,
                       f"greenguard/{ENV}/grafana-admin": MOD.generated("grafana-admin"),
                       f"greenguard/{ENV}/greenguard-cdc-credentials": {"CDC_DB_PASSWORD": roles["CDC_DB_PASSWORD"]},
                       f"greenguard/{ENV}/greenguard-opensearch-admin": MOD.generated("greenguard-opensearch-admin"),
                       f"greenguard/{ENV}/greenguard-opensearch-clients": MOD.generated("greenguard-opensearch-clients")}
        with patch.object(MOD, "aws", side_effect=self.response) as client:
            self.assertEqual(MOD.main(FLAGS + ["--apply"]), 0)
            self.assertFalse(any(c.args[1] == "put-secret-value" for c in client.call_args_list))

    def test_existing_cdc_mismatch_rejected_before_any_write(self):
        self.values = {f"greenguard/{ENV}/greenguard-rds-bootstrap": MOD.generated("greenguard-rds-bootstrap"),
                       f"greenguard/{ENV}/greenguard-cdc-credentials": {"CDC_DB_PASSWORD": "wrong"}}
        with patch.object(MOD, "aws", side_effect=self.response) as client:
            with self.assertRaisesRegex(RuntimeError, "differs"):
                MOD.main(FLAGS + ["--apply"])
            self.assertFalse(any(c.args[1] == "put-secret-value" for c in client.call_args_list))

    def test_partial_bootstrap_missing_cdc_is_seeded_from_current(self):
        roles = MOD.generated("greenguard-rds-bootstrap")
        self.values = {f"greenguard/{ENV}/greenguard-rds-bootstrap": roles}
        with patch.object(MOD, "aws", side_effect=self.response) as client:
            self.assertEqual(MOD.main(FLAGS + ["--apply"]), 0)
            puts = [c for c in client.call_args_list if c.args[1] == "put-secret-value"]
            self.assertEqual(len(puts), 4)
            self.assertEqual(self.values[f"greenguard/{ENV}/greenguard-cdc-credentials"],
                             {"CDC_DB_PASSWORD": roles["CDC_DB_PASSWORD"]})

    def test_partial_opensearch_sources_preserve_existing(self):
        admin = MOD.generated("greenguard-opensearch-admin")
        self.values = {f"greenguard/{ENV}/greenguard-opensearch-admin": admin}
        with patch.object(MOD, "aws", side_effect=self.response) as client:
            self.assertEqual(MOD.main(FLAGS + ["--apply"]), 0)
            puts = [c for c in client.call_args_list if c.args[1] == "put-secret-value"]
            self.assertEqual(len(puts), 4)
            self.assertEqual(self.values[f"greenguard/{ENV}/greenguard-opensearch-admin"], admin)
            clients = self.values[f"greenguard/{ENV}/greenguard-opensearch-clients"]
            self.assertEqual(set(clients), {"writer-password", "reader-password", "acceptance-writer-password", "acceptance-reader-password"})
            self.assertNotEqual(clients["writer-password"], clients["reader-password"])

    def test_malformed_existing_opensearch_source_rejected_before_writes(self):
        self.values = {f"greenguard/{ENV}/greenguard-opensearch-clients": {"wrong": "bad"}}
        with patch.object(MOD, "aws", side_effect=self.response) as client:
            with self.assertRaisesRegex(RuntimeError, "invalid keys"):
                MOD.main(FLAGS + ["--apply"])
            self.assertFalse(any(c.args[1] == "put-secret-value" for c in client.call_args_list))

    def test_partial_cdc_present_without_bootstrap_rejected(self):
        self.values = {f"greenguard/{ENV}/greenguard-cdc-credentials": {"CDC_DB_PASSWORD": "orphan"}}
        with patch.object(MOD, "aws", side_effect=self.response) as client:
            with self.assertRaisesRegex(RuntimeError, "bootstrap source is missing"):
                MOD.main(FLAGS + ["--apply"])
            self.assertFalse(any(c.args[1] == "put-secret-value" for c in client.call_args_list))

    def test_wrong_account_and_orphan_version_fail_closed(self):
        with patch.object(MOD, "aws", return_value={"Account": "000000000000"}):
            with self.assertRaisesRegex(RuntimeError, "account"):
                MOD.main(FLAGS + ["--apply"])

        def orphan(*args, payload=None):
            value = self.response(*args, payload=payload)
            if args[1] == "describe-secret":
                value["VersionIdsToStages"] = {"orphan": ["AWSPREVIOUS"]}
            return value
        with patch.object(MOD, "aws", side_effect=orphan) as client:
            with self.assertRaisesRegex(RuntimeError, "manual review"):
                MOD.main(FLAGS + ["--apply"])
            self.assertFalse(any(c.args[1] == "put-secret-value" for c in client.call_args_list))

    def test_wrong_source_or_scheduled_deletion_fails_closed(self):
        for key, bad in (("ARN", "arn:aws:secretsmanager:us-west-2:123456789012:secret:elsewhere"),
                         ("Name", "greenguard/production/grafana-admin"),
                         ("DeletedDate", "2026-09-27T00:00:00Z")):
            with self.subTest(key=key):
                def corrupt(*args, payload=None):
                    value = self.response(*args, payload=payload)
                    if args[1] == "describe-secret":
                        value[key] = bad
                    return value
                with patch.object(MOD, "aws", side_effect=corrupt) as client:
                    with self.assertRaises(RuntimeError):
                        MOD.main(FLAGS + ["--apply"])
                    self.assertFalse(any(c.args[1] == "put-secret-value" for c in client.call_args_list))


if __name__ == "__main__":
    unittest.main()
