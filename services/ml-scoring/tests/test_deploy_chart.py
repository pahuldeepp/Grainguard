from pathlib import Path
import json
import re
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[3]
CHART = ROOT / "services/ml-scoring/deploy/chart"
@unittest.skipUnless(shutil.which("helm"), "Helm is required for chart render checks")
class DeployChartTests(unittest.TestCase):
    def render(self, *values):
        return subprocess.run(
            ["helm", "template", "review", str(CHART), "--set", "cell=unit-test", "--set", "image.allowTagFallback=true", *values],
            capture_output=True, text=True, check=False,
        )

    def test_disabled_chart_renders_no_workloads(self):
        result = self.render()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "")

    def test_enabled_chart_uses_runtime_port_and_dedicated_fixture(self):
        result = self.render("--set", "enabled=true", "--set", "health.port=8181")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"name: PORT\s+value: \"8181\"")
        self.assertIn("containerPort: 8181", result.stdout)
        self.assertNotIn("ML_HEALTH_PORT", result.stdout)
        self.assertIn('value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"', result.stdout)
        self.assertEqual(len(re.findall(r"port: health\b", result.stdout)), 3)
        self.assertIn("terminationGracePeriodSeconds: 90", result.stdout)
        image = re.search(r'image: "greenguard/ml-scoring-synthetic:([^"]+)"', result.stdout)
        model_version = re.search(r'name: ML_MODEL_VERSION\s+value: "([^"]+)"', result.stdout)
        self.assertIsNotNone(image)
        self.assertIsNotNone(model_version)
        self.assertEqual(image.group(1), model_version.group(1))
        self.assertIn('sizeLimit: "64Mi"', result.stdout)

    def test_cluster_synthetic_requires_exact_cell_label(self):
        result = self.render("--set", "enabled=true", "--set-string", "cell=")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cell is required in cluster-synthetic mode", result.stderr)

    def test_chart_image_and_model_versions_match_bundled_model(self):
        values = (CHART / "values.yaml").read_text()
        dockerfile = (CHART.parents[0] / "Dockerfile").read_text()
        image_tag = re.search(r"^  tag: (\S+)$", values, re.MULTILINE)
        model_version = re.search(r"^  version: (\S+)$", values, re.MULTILINE)
        bundle = re.search(
            r"^COPY .*?evidence/model-registry/greenguard\.hotspot-transition\.classifier/"
            r"([^/\s]+)\s*\\\n\s+/models/greenguard\.hotspot-transition\.classifier/([^/\s]+)$",
            dockerfile,
            re.MULTILINE,
        )
        self.assertIsNotNone(image_tag)
        self.assertIsNotNone(model_version)
        self.assertIsNotNone(bundle)
        self.assertEqual(image_tag.group(1), model_version.group(1))
        self.assertEqual(model_version.group(1), bundle.group(1))
        self.assertEqual(bundle.group(1), bundle.group(2))
        manifest_path = (
            ROOT / "evidence/model-registry/greenguard.hotspot-transition.classifier"
            / bundle.group(1) / "manifest.json"
        )
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(model_version.group(1), manifest["model_version"])

    def test_enabled_chart_uses_immutable_digest_for_all_containers_and_jobs(self):
        digest = "sha256:" + "a" * 64
        result = self.render(
            "--set", "enabled=true",
            "--set", "syntheticFixtureSeed.enabled=true",
            "--set", f"image.digest={digest}",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count(f'image: "greenguard/ml-scoring-synthetic@{digest}"'), 3)
        self.assertNotIn("greenguard/ml-scoring-synthetic:i4-transformer", result.stdout)

    def test_enabled_chart_requires_explicit_local_tag_opt_in(self):
        result = self.render("--set", "enabled=true", "--set", "image.allowTagFallback=false")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("image.digest is required", result.stderr)

    def test_fixture_rejects_incomplete_grid(self):
        result = self.render("--set", "enabled=true", "--set", "syntheticFixtureSeed.enabled=true", "--set", "syntheticFixtureSeed.count=383")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exactly 384", result.stderr)

    def test_enabled_chart_rejects_invalid_image_digest(self):
        for digest in ("sha256:abcd", "sha256:" + "A" * 64, "sha512:" + "a" * 64):
            with self.subTest(digest=digest):
                result = self.render(
                    "--set", "enabled=true",
                    "--set-string", f"image.digest={digest}",
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("image.digest must be sha256", result.stderr)

    def test_enabled_chart_rejects_multiple_stateful_consumers(self):
        result = self.render("--set", "enabled=true", "--set", "replicaCount=2")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("replicaCount must remain 1", result.stderr)

    def test_enabled_network_policy_rejects_empty_health_probe_sources(self):
        result = self.render(
            "--set", "enabled=true",
            "--set-json", "networkPolicy.healthProbeNamespaces=[]",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("healthProbeNamespaces must contain at least one selector", result.stderr)

    def test_enabled_chart_rejects_missing_invalid_or_reserved_tenant(self):
        for tenant in ("", "not-a-uuid", "00000000-0000-4000-8000-000000000001"):
            with self.subTest(tenant=tenant):
                result = self.render("--set", "enabled=true", "--set-string", f"syntheticTenantId={tenant}")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("syntheticTenantId", result.stderr)


if __name__ == "__main__":
    unittest.main()
