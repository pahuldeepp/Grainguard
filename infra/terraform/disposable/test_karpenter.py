"""Plan the actual Karpenter Terraform with mocked providers, without AWS access."""
from pathlib import Path
import hashlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parent


class KarpenterTerraformTests(unittest.TestCase):
    def test_identity_interruption_controller_and_disabled_defaults(self):
        with tempfile.TemporaryDirectory() as work:
            folder = Path(work)
            for name in ("karpenter.tf", ".terraform.lock.hcl"):
                shutil.copyfile(ROOT / name, folder / name)
            (folder / "main.tf").write_text('''
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 6.60.0" }
    helm = { source = "hashicorp/helm", version = "= 3.3.0" }
  }
}
provider "aws" { region = "us-east-2" }
variable "cluster_name" { default = "gg-disposable" }
variable "aws_region" { default = "us-east-2" }
variable "environment" { default = "disposable" }
variable "target_account_id" { default = "123456789012" }
locals { az_names = ["us-east-2a", "us-east-2b"] }
resource "terraform_data" "destroy_inventory_sentinel" { input = {} }
resource "terraform_data" "eks_api_reachability" { input = {} }
data "aws_iam_policy_document" "eks_node_assume_role" {}
resource "aws_eks_cluster" "cell" {
  name = var.cluster_name
  role_arn = "arn:aws:iam::123456789012:role/cluster"
  vpc_config { subnet_ids = ["subnet-0123456789abcdef0"] }
}
resource "aws_eks_node_group" "general" {
  cluster_name = var.cluster_name
  node_group_name = "general"
  node_role_arn = "arn:aws:iam::123456789012:role/node"
  subnet_ids = ["subnet-0123456789abcdef0"]
  scaling_config {
    desired_size = 2
    max_size = 6
    min_size = 2
  }
}
resource "aws_eks_addon" "pod_identity_agent" {
  cluster_name = var.cluster_name
  addon_name = "eks-pod-identity-agent"
}
resource "aws_eks_addon" "core" {
  cluster_name = var.cluster_name
  addon_name = "vpc-cni"
}
resource "aws_eks_access_policy_association" "cluster_admin" {
  cluster_name = var.cluster_name
  principal_arn = "arn:aws:iam::123456789012:role/admin"
  policy_arn = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
  access_scope { type = "cluster" }
}
''')
            (folder / "karpenter.tftest.hcl").write_text('''
mock_provider "aws" {
  override_during = plan
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\\"Version\\":\\"2012-10-17\\",\\"Statement\\":[]}" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/gg-node" }
  }
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::123456789012:instance-profile/gg-node" }
  }
  mock_resource "aws_eks_cluster" {
    defaults = {
      arn = "arn:aws:eks:us-east-2:123456789012:cluster/gg-disposable"
      vpc_config = {cluster_security_group_id = "sg-0123456789abcdef0"}
    }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-east-2:123456789012:gg-kp"
      url = "https://sqs.us-east-2.amazonaws.com/123456789012/gg-kp"
    }
  }
}
mock_provider "helm" { override_during = plan }
run "default_provisioning_disabled" {
  command = plan
  assert {
    condition = output.karpenter_capacity.total_vcpus == 0 && output.karpenter_capacity.enabled_pools == 0
    error_message = "Karpenter must not provision by default."
  }
  assert {
    condition = aws_eks_access_entry.karpenter_node.principal_arn == aws_iam_role.karpenter_node.arn && aws_eks_access_entry.karpenter_node.type == "EC2_LINUX"
    error_message = "Karpenter requires its dedicated EKS node identity."
  }
  assert {
    condition = aws_eks_pod_identity_association.karpenter.namespace == "kube-system" && aws_eks_pod_identity_association.karpenter.service_account == "karpenter"
    error_message = "Controller Pod Identity must bind the actual chart service account."
  }
  assert {
    condition = length(aws_cloudwatch_event_rule.karpenter_interruption) == 5 && length(aws_cloudwatch_event_target.karpenter_interruption) == 5 && aws_sqs_queue.karpenter_interruption.sqs_managed_sse_enabled
    error_message = "All interruption event rules require encrypted queue targets."
  }
  assert {
    condition = alltrue([for target in aws_cloudwatch_event_target.karpenter_interruption : target.arn == aws_sqs_queue.karpenter_interruption.arn])
    error_message = "Every interruption rule must target the cell-owned queue."
  }
  assert {
    condition = jsondecode(aws_sqs_queue_policy.karpenter_interruption.policy).Statement[0].Condition.ArnLike["aws:SourceArn"] == "arn:aws:events:us-east-2:123456789012:rule/gg-disposable-53686713-kp-*"
    error_message = "Queue sends must be restricted to this cell's interruption rules."
  }
  assert {
    condition = jsondecode(aws_sqs_queue_policy.karpenter_interruption.policy).Statement[1].Condition.Bool["aws:SecureTransport"] == "false"
    error_message = "Queue policy must deny unencrypted transport."
  }
  assert {
    condition = yamldecode(helm_release.karpenter.values[0]).controller.resources.requests.cpu == "250m" && yamldecode(helm_release.karpenter.values[0]).replicas == 2
    error_message = "The controller must retain two replicas and explicit requests."
  }
  assert {
    condition = yamldecode(helm_release.karpenter.values[0]).controller.image.digest == "sha256:ab0f953e1460c61566d48209b517734ba79fe2105f335af1ff85faa8b6baf157" && yamldecode(helm_release.karpenter.values[0]).settings.interruptionQueue == aws_sqs_queue.karpenter_interruption.name
    error_message = "Controller image and interruption queue must stay pinned."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.karpenter_controller.policy).Statement[5].Condition.StringEquals["aws:ResourceTag/kubernetes.io/cluster/gg-disposable"] == "owned" && jsondecode(aws_iam_role_policy.karpenter_controller.policy).Statement[11].Resource == aws_iam_role.karpenter_node.arn
    error_message = "EC2 deletions and PassRole must remain scoped to owned nodes."
  }
}
run "explicit_compute_budget" {
  command = plan
  variables {
    karpenter_compute_cpu_limit = 4
    karpenter_node_ami_alias = "al2023@v20261001"
  }
  assert {
    condition = output.karpenter_capacity.total_vcpus == 4 && output.karpenter_capacity.enabled_pools == 1 && yamldecode(helm_release.karpenter_nodepools.values[0]).pools.compute.cpuLimit == 4
    error_message = "Only the explicitly configured pool may be enabled."
  }
}
run "enabled_without_pinned_ami_rejected" {
  command = plan
  variables { karpenter_compute_cpu_limit = 4 }
  expect_failures = [var.karpenter_node_ami_alias]
}
run "floating_ami_rejected" {
  command = plan
  variables { karpenter_node_ami_alias = "al2023@latest" }
  expect_failures = [var.karpenter_node_ami_alias]
}
run "invalid_budget_rejected" {
  command = plan
  variables { karpenter_compute_cpu_limit = 33 }
  expect_failures = [var.karpenter_compute_cpu_limit]
}
run "wrong_architecture_family_rejected" {
  command = plan
  variables { karpenter_instance_families = ["m7g"] }
  expect_failures = [var.karpenter_instance_families]
}
'''.replace("53686713", hashlib.sha256(b'gg-disposable').hexdigest()[:8]))
            init = subprocess.run(["terraform", "init", "-backend=false", "-input=false", "-lockfile=readonly",
                                   "-plugin-dir=" + str((ROOT / ".terraform/providers").absolute())],
                                  cwd=folder, capture_output=True, text=True)
            self.assertEqual(init.returncode, 0, init.stdout + init.stderr)
            result = subprocess.run(["terraform", "test", "-no-color"], cwd=folder, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("6 passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
