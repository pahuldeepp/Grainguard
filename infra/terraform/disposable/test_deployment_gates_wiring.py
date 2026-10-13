import re
import unittest
from pathlib import Path

ROOT = Path(__file__).parent


def resource_block(source, kind, name):
    match = re.search(rf'resource\s+"{re.escape(kind)}"\s+"{re.escape(name)}"\s*\{{', source)
    if not match:
        raise AssertionError(f"resource {kind}.{name} is missing")
    start = match.end()
    depth = 1
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index]
    raise AssertionError(f"resource {kind}.{name} is not closed")


class DeploymentGateWiringTests(unittest.TestCase):
    def test_reachability_gate_precedes_every_root_helm_chart(self):
        controllers = (ROOT / "controllers.tf").read_text()
        bootstrap = (ROOT / "gitops.tf").read_text()
        reachability = resource_block(controllers, "terraform_data", "eks_api_reachability")
        self.assertIn("aws_eks_node_group.general", reachability)
        self.assertIn("aws_eks_access_policy_association.cluster_admin", reachability)
        self.assertIn("check-eks-api-reachability.py", reachability)
        for name in ("aws_load_balancer_controller", "istio_base", "keda", "argo_rollouts"):
            self.assertIn("terraform_data.eks_api_reachability",
                          resource_block(controllers, "helm_release", name), name)
        argocd = resource_block(controllers, "helm_release", "argocd")
        self.assertIn("helm_release.istio_ingressgateway", argocd)
        self.assertIn("helm_release.keda", argocd)
        self.assertIn("helm_release.argocd",
                      resource_block(controllers, "helm_release", "greenguard_namespace"))
        self.assertIn("helm_release.greenguard_namespace",
                      resource_block(bootstrap, "helm_release", "gitops_bootstrap"))

    def test_application_gate_is_fail_closed_and_tracks_release_revision(self):
        source = (ROOT / "gitops.tf").read_text()
        gate = resource_block(source, "terraform_data", "deployed_workload_acceptance")
        self.assertIn("count = var.enable_application_tree ? 1 : 0", gate)
        self.assertIn("triggers_replace = helm_release.gitops_bootstrap[0].metadata.revision", gate)
        dependencies = re.search(r"depends_on\s*=\s*\[(.*?)\]", gate, re.S)
        self.assertIsNotNone(dependencies, "application acceptance dependencies are missing")
        self.assertIn("helm_release.gitops_bootstrap", dependencies.group(1))
        self.assertIn("terraform_data.destroy_inventory_sentinel", dependencies.group(1))
        self.assertIn("run-deployed-workloads.py", gate)
        self.assertIn("GG_DISPOSABLE_ACCEPTANCE_TIMEOUT_SECONDS", gate)
        self.assertIn("migration_gate_image_digest", gate)
        self.assertIn("migration_image_digests", gate)
        self.assertIn("migration_sql_image_digest", gate)
        self.assertNotIn("on_failure", gate)

    def test_readiness_gate_rejects_infrastructure_only_apply(self):
        source = (ROOT / "readiness.tf").read_text()
        gate = resource_block(source, "terraform_data", "deployment_readiness_gate")
        self.assertNotIn("allow_incomplete_foundation_plan", source)
        self.assertIn("condition     = var.enable_application_tree", gate)
        self.assertIn("Refusing an infrastructure-only GreenGuard apply", gate)
        self.assertIn(
            'resource "terraform_data" "deployed_workload_acceptance"',
            (ROOT / "gitops.tf").read_text(),
        )

    def test_secret_state_exposure_is_connected_to_the_materialization_path(self):
        runtime = (ROOT / "runtime-secrets.tf").read_text()
        shards = (ROOT / "shard-secret-values.tf").read_text()
        self.assertIn('resource "aws_secretsmanager_secret_version" "runtime"', runtime)
        self.assertRegex(runtime, r"secret_string_wo\s*= try\(jsonencode\(local\.runtime_secret_owned_values\[each\.key\]\), jsonencode\(\{\}\)\)")
        self.assertIn('resource "aws_secretsmanager_secret_version" "shard_routing"', shards)
        self.assertRegex(shards, r"secret_string_wo\s*= jsonencode\(local\.shard_registry_values\[each\.key\]\)")

    def test_ai_enablement_requires_complete_source_inventory_and_images(self):
        runtime = (ROOT / "ai-runtime.tf").read_text()
        images = (ROOT / "ai-gitops.tf").read_text()
        inventory = (ROOT.parent.parent / "gitops/disposable/platform-image-inventory.json").read_text()
        self.assertIn("!var.ai_runtime_enabled || (var.ai_runtime_sources_complete", runtime)
        self.assertIn('default     = false', images[images.index('variable "ai_runtime_sources_complete"'):])
        ai_images = __import__("json").loads(inventory)["ai_runtime_images"]
        self.assertEqual({entry["status"] for entry in ai_images}, {"source_present"})
        self.assertEqual(len(ai_images), 7)


if __name__ == "__main__":
    unittest.main()
