"""Offline tests for the disposable live evidence inventory gate."""

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys


SOURCE = Path(__file__).with_name("check-live-acceptance.py")
SPEC = importlib.util.spec_from_file_location("check_live_acceptance", SOURCE)
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


class LiveAcceptanceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        evidence = self.root / "evidence"
        evidence.mkdir()
        artifact = evidence / "redacted-response.txt"
        artifact.write_text("synthetic deployed response marker\n")
        digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
        self.manifest = {
            "schemaVersion": 1,
            "scope": {
                "accountId": "123456789012",
                "region": "ca-central-1",
                "cluster": "greenguard-disposable",
                "gitRevision": "a" * 40,
                "startedAt": "2026-09-27T10:00:00Z",
                "endedAt": "2026-09-27T11:00:00Z",
            },
            "checks": [{
                "id": name,
                "status": "PASS",
                "expected": "synthetic expected result",
                "observation": "synthetic observed result",
                "operator": "test operator",
                "observedAt": "2026-09-27T10:30:00Z",
                "artifacts": [{"path": "evidence/redacted-response.txt", "sha256": digest}],
            } for name in checker.REQUIRED],
        }
        root_patch = patch.object(checker, "ROOT", self.root)
        evidence_patch = patch.object(checker, "EVIDENCE", evidence)
        root_patch.start()
        evidence_patch.start()
        self.addCleanup(root_patch.stop)
        self.addCleanup(evidence_patch.stop)

    def test_complete_manifest_passes_inventory(self):
        self.assertEqual(checker.verify(self.manifest), [])

    def test_wrong_account_and_revision_fail(self):
        self.manifest["scope"]["accountId"] = "other-account"
        self.manifest["scope"]["gitRevision"] = "main"
        failures = checker.verify(self.manifest)
        self.assertTrue(any("accountId" in item for item in failures))
        self.assertTrue(any("gitRevision" in item for item in failures))

    def test_missing_journey_fails(self):
        self.manifest["checks"] = [item for item in self.manifest["checks"]
                                   if item["id"] != "iphone-physical-login"]
        self.assertIn("missing live check: iphone-physical-login", checker.verify(self.manifest))

    def test_missing_service_probe_fails(self):
        self.manifest["checks"] = [item for item in self.manifest["checks"]
                                   if item["id"] != "kafka-produce-consume"]
        self.assertIn("missing live check: kafka-produce-consume", checker.verify(self.manifest))

    def test_each_dependency_probe_group_is_required(self):
        dependency_probes = (
            "pgbouncer-transaction-pool",
            "kafka-connect-connector-status",
            "schema-registry-subject-compatibility",
            "rabbitmq-publish-consume",
            "mqtt-tls-auth-publish-subscribe",
            "clickhouse-roundtrip",
            "tenant-membership-readback",
            "object-storage-audit-export-roundtrip",
        )
        for probe in dependency_probes:
            with self.subTest(probe=probe):
                checks = [item for item in self.manifest["checks"] if item["id"] != probe]
                self.assertIn(f"missing live check: {probe}", checker.verify({**self.manifest, "checks": checks}))

    def test_clickhouse_and_tenant_membership_require_live_receipts(self):
        for probe in ("clickhouse-roundtrip", "tenant-membership-readback"):
            with self.subTest(probe=probe):
                manifest = json.loads(json.dumps(self.manifest))
                item = next(check for check in manifest["checks"] if check["id"] == probe)
                item["status"] = "BLOCKED"
                failures = checker.verify(manifest)
                self.assertIn(f"{probe}: live status is not PASS", failures)

    def test_contract_acceptance_ids_match_the_live_checker_exactly(self):
        contract = json.loads((SOURCE.parent / "contract.json").read_text())
        acceptance = next(phase for phase in contract["phases"] if phase["id"] == "acceptance")
        contract_ids = acceptance["probes"] + acceptance["journeys"]
        self.assertEqual(len(contract_ids), len(set(contract_ids)), "acceptance IDs must be unique")
        self.assertEqual(set(contract_ids), set(checker.REQUIRED))

    def test_web_and_iphone_login_acceptance_preserves_selected_oidc_provider(self):
        runbook = (SOURCE.parent.parents[2] / "docs/runbooks/disposable-live-acceptance.md").read_text()
        web_login = next(line for line in runbook.splitlines() if "`web-login`" in line)
        iphone_section = runbook.split("## Physical iPhone", 1)[1]
        iphone_login = next(line for line in iphone_section.splitlines() if "`iphone-physical-login`" in line)

        self.assertIn("selected OIDC provider", web_login)
        self.assertIn("Authorization Code + PKCE", web_login)
        self.assertIn("only when `identity_mode = \"cognito\"` is explicitly selected", web_login)
        self.assertNotIn("Cognito hosted page", web_login)
        self.assertIn("selected deployed OIDC issuer", iphone_section)
        self.assertIn("Authorization Code + PKCE", iphone_login)

    def test_valid_inventory_is_blocked_pending_human_acceptance_review(self):
        manifest_path = self.root / "manifest.json"
        manifest_path.write_text(json.dumps(self.manifest))
        with patch.object(sys, "argv", [str(SOURCE), str(manifest_path)]):
            self.assertEqual(checker.main(), 2)

    def test_missing_user_journey_stays_required(self):
        self.manifest["checks"] = [item for item in self.manifest["checks"]
                                   if item["id"] != "web-login"]
        self.assertIn("missing live check: web-login", checker.verify(self.manifest))

    def test_hash_mismatch_fails(self):
        self.manifest["checks"][0]["artifacts"][0]["sha256"] = "0" * 64
        self.assertTrue(any("hash mismatch" in item for item in checker.verify(self.manifest)))

    def test_path_escape_fails(self):
        escaped = self.root / "outside.txt"
        escaped.write_text("synthetic outside file")
        self.manifest["checks"][0]["artifacts"][0] = {
            "path": "evidence/../outside.txt",
            "sha256": hashlib.sha256(escaped.read_bytes()).hexdigest(),
        }
        self.assertTrue(any("outside evidence" in item for item in checker.verify(self.manifest)))

    def test_malformed_field_types_fail_without_exception(self):
        self.manifest["scope"]["accountId"] = ["123456789012"]
        self.manifest["scope"]["startedAt"] = []
        self.manifest["checks"][0]["id"] = []
        self.manifest["checks"][0]["observation"] = {"unexpected": "object"}
        self.manifest["checks"][0]["operator"] = ["name"]
        self.manifest["checks"][1]["artifacts"][0]["path"] = []
        failures = checker.verify(self.manifest)
        self.assertTrue(any("scope.accountId" in item for item in failures))
        self.assertTrue(any("check ids must be strings" in item for item in failures))
        self.assertTrue(any("startedAt" in item for item in failures))
        self.assertTrue(any("expected and observed" in item for item in failures))
        self.assertTrue(any("operator required" in item for item in failures))
        self.assertTrue(any("artifact path must be a string" in item for item in failures))


if __name__ == "__main__":
    unittest.main()
