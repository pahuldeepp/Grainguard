import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).parent
REPO = ROOT.parents[2]


class ShardRoutingRequiredContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gitops = (ROOT / "gitops.tf").read_text()
        cls.application_chart = (
            REPO / "infra/gitops/disposable/applications-chart/templates/applications.yaml"
        ).read_text()
        cls.render_test = (REPO / "infra/gitops/disposable/check-application-tree.rb").read_text()
        cls.contract = json.loads(
            (REPO / "infra/gitops/disposable/contract.json").read_text()
        )

    def test_tenant_owned_release_profiles_require_registry_routing(self):
        release_map = re.search(
            r"shard_registry_by_release\s*=\s*\{([\s\S]*?)\n\s*\}",
            self.gitops,
        )
        self.assertIsNotNone(release_map)
        mapped_releases = set(
            re.findall(r'"([a-z0-9-]+)"\s*=\s*\{\s*service\s*=', release_map.group(1))
        )
        self.assertTrue(mapped_releases)
        contract_releases = {release["name"] for release in self.contract["releases"]}
        self.assertTrue(mapped_releases <= contract_releases)
        render_set = re.search(r"shard_routed_releases\s*=\s*%w\[([^]]+)\]", self.render_test)
        self.assertIsNotNone(render_set)
        self.assertEqual(set(render_set.group(1).split()), mapped_releases)

        # Terraform derives this bit and injects the mode in the same branch
        # that mounts the private per-service registry. Central-only releases
        # have null shardRegistry and therefore receive no forced shard mode.
        self.assertIn(
            "shardRoutingRequired = release.shardRegistry != null", self.gitops
        )
        self.assertRegex(
            self.gitops,
            r'release\.shardRegistry != null\s*\?\s*\[\s*\{\s*name\s*=\s*"SHARD_ROUTING_REQUIRED",\s*value\s*=\s*"true"\s*\}',
        )

    def test_application_chart_rejects_missing_required_mode(self):
        self.assertIn("if .shardRoutingRequired", self.application_chart)
        self.assertIn('"SHARD_ROUTING_REQUIRED"', self.application_chart)
        self.assertIn('"true"', self.application_chart)
        self.assertIn("SHARD_ROUTING_REQUIRED=true is required", self.application_chart)


if __name__ == "__main__":
    unittest.main()
