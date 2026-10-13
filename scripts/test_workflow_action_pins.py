"""Guard CI action references against mutable tags and malformed commit pins."""

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
USE_LINE = re.compile(r"(?m)^\s*uses:\s*([^\s#]+)")
ACTION_REF = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$")
COSIGN_INSTALLER = "sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6"


def is_immutable_action_ref(reference):
    return reference.startswith("./") or bool(ACTION_REF.fullmatch(reference))


class WorkflowActionPinTests(unittest.TestCase):
    def test_action_reference_requires_a_full_lowercase_commit_sha(self):
        self.assertTrue(is_immutable_action_ref("actions/checkout@" + "a" * 40))
        self.assertTrue(is_immutable_action_ref("owner/repo/subdir@" + "0" * 40))
        self.assertTrue(is_immutable_action_ref("./.github/actions/local"))
        for reference in (
            "actions/checkout@v4",
            "actions/checkout@" + "a" * 39,
            "actions/checkout@" + "A" * 40,
            "actions/checkout",
        ):
            with self.subTest(reference=reference):
                self.assertFalse(is_immutable_action_ref(reference))

    def test_ci_workflow_uses_only_immutable_action_references(self):
        references = USE_LINE.findall(WORKFLOW.read_text())
        self.assertGreater(len(references), 0)
        invalid = [reference for reference in references if not is_immutable_action_ref(reference)]
        self.assertEqual(invalid, [], f"mutable or malformed GitHub Action references: {invalid}")

    def test_cosign_installer_uses_the_verified_commit_pin_everywhere(self):
        references = [reference for reference in USE_LINE.findall(WORKFLOW.read_text())
                      if reference.startswith("sigstore/cosign-installer@")]
        self.assertEqual(references, [COSIGN_INSTALLER] * 3)


if __name__ == "__main__":
    unittest.main()
