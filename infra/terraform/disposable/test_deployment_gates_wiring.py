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
        self.assertIn("depends_on       = [helm_release.gitops_bootstrap]", gate)
        self.assertIn("run-deployed-workloads.py", gate)
        self.assertNotIn("on_failure", gate)

    def test_offline_readiness_gate_stays_closed_by_default(self):
        source = (ROOT / "readiness.tf").read_text()
        self.assertIn("default     = false", source)
        self.assertIn("count = var.allow_incomplete_foundation_plan ? 0 : 1", source)
        self.assertIn("Do not apply it as a complete cell", source)


if __name__ == "__main__":
    unittest.main()
