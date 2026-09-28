"""The disposable runtime must propagate one private control-plane token."""

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).parent
REPO = ROOT.parents[2]


class ControlLookupTokenContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.terraform = (ROOT / "runtime-secrets.tf").read_text()
        cls.preflight = (REPO / "infra/gitops/disposable/check-secrets-ready.py").read_text()
        cls.gitops = (ROOT / "gitops.tf").read_text()
        cls.deployment_contract = json.loads(
            (REPO / "infra/gitops/disposable/contract.json").read_text()
        )

    def test_every_control_plane_client_gets_the_authority_secret_value(self):
        tf = re.search(
            r"control_lookup_secret_consumers\s*=\s*toset\(\[([\s\S]*?)\]\)",
            self.terraform,
        )
        py = re.search(
            r"CONTROL_LOOKUP_SECRET_CONSUMERS\s*=\s*\{([\s\S]*?)\n\}",
            self.preflight,
        )
        self.assertIsNotNone(tf)
        self.assertIsNotNone(py)
        terraform_names = set(re.findall(r'"([a-z0-9-]+)"', tf.group(1)))
        preflight_names = set(re.findall(r'"([a-z0-9-]+)"', py.group(1)))
        self.assertEqual(terraform_names, preflight_names - {"audit-export-worker-config"})
        self.assertIn(
            'CONTROL_LOOKUP_TOKEN = try(var.runtime_secret_values["tenant-control-plane-config"]["CONTROL_LOOKUP_TOKEN"], "")',
            self.terraform,
        )
        self.assertIn(
            'CONTROL_LOOKUP_TOKEN         = try(var.runtime_secret_values["tenant-control-plane-config"]["CONTROL_LOOKUP_TOKEN"], "")',
            self.terraform,
        )

    def test_consumer_list_tracks_shard_routing_and_membership_release_contracts(self):
        shard_registry = re.search(
            r"shard_registry_by_release\s*=\s*\{([\s\S]*?)\n\s*\}",
            self.gitops,
        )
        membership = re.search(
            r"membership_verifier_releases\s*=\s*toset\(\[([\s\S]*?)\]\)",
            self.gitops,
        )
        self.assertIsNotNone(shard_registry)
        self.assertIsNotNone(membership)
        release_names = set(re.findall(r'^\s*"([^"]+)"\s*=\s*\{', shard_registry.group(1), re.M))
        release_names.update(re.findall(r'"([^"]+)"', membership.group(1)))
        contract_secrets = {
            release["secret"]
            for release in self.deployment_contract["releases"]
            if release["name"] in release_names
        }
        contract_secrets.add("tenant-control-plane-config")

        terraform_block = re.search(
            r"control_lookup_secret_consumers\s*=\s*toset\(\[([\s\S]*?)\]\)",
            self.terraform,
        )
        preflight_block = re.search(
            r"CONTROL_LOOKUP_SECRET_CONSUMERS\s*=\s*\{([\s\S]*?)\n\}",
            self.preflight,
        )
        self.assertIsNotNone(terraform_block)
        self.assertIsNotNone(preflight_block)
        terraform_names = set(re.findall(r'"([a-z0-9-]+)"', terraform_block.group(1)))
        preflight_names = set(re.findall(r'"([a-z0-9-]+)"', preflight_block.group(1)))
        self.assertEqual(terraform_names, contract_secrets - {"audit-export-worker-config"})
        self.assertEqual(preflight_names, contract_secrets)

    def test_canonical_token_is_length_checked_and_preflight_compares_consumers(self):
        self.assertIn('each.key != "tenant-control-plane-config" || try(length(var.runtime_secret_values[each.key]["CONTROL_LOOKUP_TOKEN"]) >= 32, false)', self.terraform)
        self.assertIn("token != canonical_token", self.preflight)
        self.assertIn("CONTROL_LOOKUP_TOKEN differs from the control-plane authority token", self.preflight)


if __name__ == "__main__":
    unittest.main()
