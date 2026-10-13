"""Offline Karpenter render contracts; no Kubernetes or AWS calls."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

CHART = Path(__file__).resolve().parent


def fixture(compute=0, general=0):
    return {"cell": "gg-disposable", "environment": "disposable", "instanceProfile": "gg-node",
            "amiAlias": "al2023@v20261001" if compute or general else "",
            "zones": ["us-east-2a", "us-east-2b"], "instanceFamilies": ["c7i", "m7i"],
            "pools": {"compute": {"cpuLimit": compute}, "general": {"cpuLimit": general}}}


def render(values):
    with tempfile.TemporaryDirectory() as work:
        path = Path(work) / "values.json"
        path.write_text(json.dumps(values))
        result = subprocess.run(["helm", "template", "karpenter-nodepools", str(CHART), "-f", str(path)],
                                capture_output=True, text=True)
        if result.returncode:
            raise ValueError(result.stderr)
        parsed = subprocess.run(["ruby", "-ryaml", "-rjson", "-e",
                                 "puts JSON.generate(YAML.load_stream(STDIN.read).compact)"],
                                input=result.stdout, capture_output=True, text=True, check=True)
        return json.loads(parsed.stdout)


class NodePoolContracts(unittest.TestCase):
    def test_disabled_renders_no_provisioning_resources_and_needs_no_ami(self):
        self.assertEqual(render(fixture()), [])

    def test_both_pools_keep_limits_workload_labels_and_taints(self):
        objects = render(fixture(4, 2))
        pools = {obj["metadata"]["name"]: obj for obj in objects if obj["kind"] == "NodePool"}
        self.assertEqual(set(pools), {"greenguard-compute", "greenguard-general"})
        for name, limit in (("compute", "4"), ("general", "2")):
            spec = pools["greenguard-" + name]["spec"]
            self.assertEqual(spec["limits"]["cpu"], limit)
            self.assertEqual(spec["template"]["metadata"]["labels"]["greenguard.io/workload-class"], name)
            self.assertEqual(spec["disruption"]["budgets"], [{"nodes": "1"}])
            template = spec["template"]["spec"]
            self.assertEqual(template["nodeClassRef"], {"group": "karpenter.k8s.aws", "kind": "EC2NodeClass", "name": "greenguard-disposable"})
            requirements = {item["key"]: item["values"] for item in template["requirements"]}
            self.assertEqual(requirements["karpenter.sh/capacity-type"], ["on-demand"])
            self.assertEqual(requirements["kubernetes.io/arch"], ["amd64"])
            self.assertEqual(requirements["karpenter.k8s.aws/instance-cpu"], ["2", "4"])
            if name == "compute":
                self.assertEqual(template["taints"], [{"key": "greenguard.io/workload-class", "value": "compute", "effect": "NoSchedule"}])
            else:
                self.assertNotIn("taints", template)

    def test_independent_pool_enabling(self):
        for compute, general in ((4, 0), (0, 2)):
            with self.subTest(compute=compute, general=general):
                objects = render(fixture(compute, general))
                self.assertEqual([obj["kind"] for obj in objects], ["EC2NodeClass", "NodePool"])
                self.assertEqual(objects[1]["metadata"]["name"], "greenguard-" + ("compute" if compute else "general"))

    def test_nodeclass_has_private_discovery_owned_profile_and_encrypted_storage(self):
        nodeclass = render(fixture(4))[0]
        spec = nodeclass["spec"]
        self.assertEqual(spec["instanceProfile"], "gg-node")
        self.assertNotIn("role", spec)
        self.assertEqual(spec["amiSelectorTerms"], [{"alias": "al2023@v20261001"}])
        self.assertFalse(spec["associatePublicIPAddress"])
        self.assertEqual(spec["metadataOptions"]["httpTokens"], "required")
        self.assertEqual(spec["metadataOptions"]["httpPutResponseHopLimit"], 1)
        for field in ("subnetSelectorTerms", "securityGroupSelectorTerms"):
            self.assertEqual(spec[field], [{"tags": {"karpenter.sh/discovery": "gg-disposable"}}])
        ebs = spec["blockDeviceMappings"][0]["ebs"]
        self.assertTrue(ebs["encrypted"])
        self.assertTrue(ebs["deleteOnTermination"])
        self.assertEqual(spec["tags"], {"Project": "GreenGuard", "Environment": "disposable", "Cell": "gg-disposable", "Lifecycle": "Disposable", "ManagedBy": "Karpenter"})

    def test_invalid_configuration_cannot_render(self):
        for key, value in (("cell", "../neighbor"), ("environment", "production"), ("instanceProfile", ""),
                           ("amiAlias", "al2023@latest"), ("amiAlias", ""), ("zones", ["us-east-2a"]),
                           ("instanceCpus", ["2", "8"]), ("instanceCpus", ["1", "4"]),
                           ("arch", "arm64"), ("instanceFamilies", ["m7g"]), ("instanceFamilies", [])):
            values = fixture(4)
            values[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                render(values)
        for limit in (-1, 1, 33, "2.5", "unlimited"):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                render(fixture(limit))


if __name__ == "__main__":
    unittest.main()
