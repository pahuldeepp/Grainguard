"""Offline tests for the disposable live evidence inventory gate."""

import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


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
