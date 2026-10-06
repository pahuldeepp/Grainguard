"""Offline guards for out-of-band disposable secret synchronization."""

import base64
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


SOURCE = Path(__file__).with_name("sync-secrets.py")
SPEC = importlib.util.spec_from_file_location("sync_secrets", SOURCE)
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.record = {"data": {"TOKEN": "dummy-sensitive-value"},
                       "source": "greenguard/disposable/bff-config",
                       "version": "source-v1", "master_version": ""}
        self.desired = sync.desired_secret("bff-config", "greenguard", self.record, None)

    def existing(self):
        desired = self.desired
        return {"type": "Opaque", "metadata": {
            "resourceVersion": "7", "labels": desired["metadata"]["labels"],
            "annotations": desired["metadata"]["annotations"]},
            "data": {"TOKEN": base64.b64encode(b"dummy-sensitive-value").decode()}}

    def test_cassandra_secret_mounts_binary_keystore_not_base64_text(self):
        raw = b"\x30\x82\xff\x00binary-keystore-fixture"
        record = {"data": {"server.p12": base64.b64encode(raw).decode(), "keystore-password": "dummy-password", "ca.crt": "certificate-pem"},
                  "source": "greenguard/disposable/greenguard-cassandra-tls", "version": "source-v1", "master_version": ""}
        desired = sync.desired_secret("greenguard-cassandra-tls", "greenguard", record, None)
        self.assertNotIn("stringData", desired)
        self.assertEqual(raw, base64.b64decode(desired["data"]["server.p12"]))
        self.assertEqual(b"dummy-password", base64.b64decode(desired["data"]["keystore-password"]))
        existing = {**desired, "metadata": {**desired["metadata"], "resourceVersion": "8"}}
        self.assertTrue(sync.same_secret(existing, desired))

    def test_new_secret_uses_string_data_and_owner(self):
        self.assertEqual(self.desired["metadata"]["labels"]["app.kubernetes.io/managed-by"], sync.OWNER)
        self.assertEqual(self.desired["stringData"], self.record["data"])
        self.assertNotIn("resourceVersion", self.desired["metadata"])

    def test_existing_owned_secret_is_idempotent(self):
        current = self.existing()
        desired = sync.desired_secret("bff-config", "greenguard", self.record, current)
        self.assertEqual(desired["metadata"]["resourceVersion"], "7")
        self.assertTrue(sync.same_secret(current, desired))
        current["metadata"]["annotations"]["greenguard.io/aws-version-id"] = "source-v0"
        self.assertFalse(sync.same_secret(current, desired))

    def test_unowned_secret_cannot_be_replaced(self):
        current = self.existing()
        current["metadata"]["labels"].clear()
        with self.assertRaisesRegex(RuntimeError, "unowned"):
            sync.desired_secret("bff-config", "greenguard", self.record, current)

    def test_source_change_cannot_be_replaced(self):
        current = self.existing()
        current["metadata"]["annotations"]["greenguard.io/aws-secret-name"] = "other"
        with self.assertRaisesRegex(RuntimeError, "source annotation"):
            sync.desired_secret("bff-config", "greenguard", self.record, current)

    def test_write_passes_values_on_stdin_only(self):
        result = Mock(returncode=0, stdout="secret/bff-config\n")
        with patch.object(sync.subprocess, "run", return_value=result) as run:
            sync.write_secret(self.desired, False)
        argv = run.call_args.args[0]
        self.assertEqual(argv, ["kubectl", "create", "-f", "-", "-o", "name"])
        self.assertNotIn("dummy-sensitive-value", " ".join(argv))
        self.assertEqual(json.loads(run.call_args.kwargs["input"])["stringData"], self.record["data"])

    def test_dry_run_never_writes(self):
        with patch.object(sys, "argv", ["sync-secrets.py"]), \
             patch.object(sync.preflight, "arguments", return_value=SimpleNamespace(namespace="greenguard")), \
             patch.object(sync.preflight, "expected_secrets", return_value={"bff-config": self.record}), \
             patch.object(sync, "existing_secret", return_value=None), \
             patch.object(sync, "write_secret") as write:
            self.assertEqual(sync.main(), 1)
            write.assert_not_called()


if __name__ == "__main__":
    unittest.main()
