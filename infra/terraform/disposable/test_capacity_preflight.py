"""Exercise the actual capacity guard with Terraform's mocked AWS provider."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parent

class CapacityPreflightTests(unittest.TestCase):
    def test_plan_guards_and_destroy_after_quota_drop(self):
        with tempfile.TemporaryDirectory() as work:
            folder = Path(work)
            for name in ("capacity-preflight.tf", "scope_override.tf", ".terraform.lock.hcl"):
                shutil.copyfile(ROOT / name, folder / name)
            (folder / "main.tf").write_text('''
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 6.60.0" }
    helm = { source = "hashicorp/helm", version = "= 3.3.0" }
  }
}
provider "aws" { region = "us-east-2" }
variable "general_instance_types" { default = ["m7i.large"] }
variable "compute_instance_types" { default = ["m7i.xlarge"] }
variable "general_node_max_size" { default = 6 }
variable "compute_node_max_size" { default = 4 }
variable "ai_runtime_enabled" { default = true }
variable "aws_region" { default = "us-east-2" }
variable "environment" { default = "disposable" }
variable "cluster_name" { default = "gg-mock" }
variable "target_account_id" { default = "123456789012" }
locals {
  postgres_shard_ids = toset(["s1", "s2", "s3", "s4"])
  postgres_shard_replicas = { s1 = "r1", s2 = "r1", s3 = "r1", s4 = "r1" }
}
resource "terraform_data" "cell_scope" {
  input = { cluster_name = var.cluster_name, environment = var.environment }
}
resource "terraform_data" "destroy_inventory_sentinel" { input = {} }
resource "aws_vpc" "cell" { cidr_block = "10.0.0.0/16" }
''')
            (folder / "capacity.tftest.hcl").write_text('''
mock_provider "aws" {
  override_during = plan
  mock_data "aws_servicequotas_service_quota" { defaults = { value = 32 } }
  mock_data "aws_ec2_instance_type" { defaults = { default_vcpus = 2 } }
}
override_data {
  target = data.aws_servicequotas_service_quota.rds_instances
  values = { value = 40 }
}
override_data {
  target = data.aws_ec2_instance_type.capacity["m7i.xlarge"]
  values = { default_vcpus = 4 }
}
run "sufficient_capacity" {
  command = plan
  assert {
    condition = output.disposable_capacity_requirement.required_standard_vcpus == 32
    error_message = "All managed pool maxima, including the parser, must be counted."
  }
  assert {
    condition = output.disposable_capacity_requirement.required_rds_instances == 9
    error_message = "Central database plus four primary/replica pairs must be counted."
  }
}
run "cpu_quota_too_small" {
  command = plan
  override_data {
    target = data.aws_servicequotas_service_quota.standard_vcpus
    values = { value = 8 }
  }
  expect_failures = [output.disposable_capacity_requirement]
}
run "rds_quota_too_small" {
  command = plan
  override_data {
    target = data.aws_servicequotas_service_quota.rds_instances
    values = { value = 8 }
  }
  expect_failures = [output.disposable_capacity_requirement]
}
run "empty_instance_list" {
  command = plan
  variables { general_instance_types = [] }
  expect_failures = [output.disposable_capacity_requirement]
}
run "create_mock_cell" { command = apply }
''')
            init = subprocess.run(["terraform", "init", "-backend=false", "-input=false", "-lockfile=readonly",
                                   "-plugin-dir=" + str((ROOT / ".terraform/providers").absolute())],
                                  cwd=folder, capture_output=True, text=True)
            self.assertEqual(init.returncode, 0, init.stdout + init.stderr)
            result = subprocess.run(["terraform", "test", "-no-color"], cwd=folder, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("5 passed", result.stdout)
            # Prove destroy semantics on the actual output preconditions, with
            # quota transport replaced by variables. No AWS provider/resources
            # exist in this second fixture; its state holds only a built-in placeholder.
            destroy = folder / "destroy-fixture"; destroy.mkdir()
            guard = (ROOT / "capacity-preflight.tf").read_text().split('output "disposable_capacity_requirement"', 1)[1]
            guard = 'output "disposable_capacity_requirement"' + guard
            guard = guard.replace("data.aws_servicequotas_service_quota.standard_vcpus.value", "var.approved_vcpus")
            guard = guard.replace("data.aws_servicequotas_service_quota.rds_instances.value", "var.approved_rds")
            (destroy / "main.tf").write_text("""
variable "approved_vcpus" { default = 32 }
variable "approved_rds" { default = 40 }
variable "general_instance_types" { default = ["mock"] }
variable "compute_instance_types" { default = ["mock"] }
locals {
  required_capacity_vcpus = 32
  required_rds_instances = 9
}
resource "terraform_data" "mock_cell" { input = true }
""" + guard)
            for arguments in [["init", "-backend=false", "-input=false"],
                              ["apply", "-auto-approve", "-input=false"],
                              ["destroy", "-auto-approve", "-input=false", "-var=approved_vcpus=8", "-var=approved_rds=8"]]:
                checked = subprocess.run(["terraform", *arguments], cwd=destroy, capture_output=True, text=True)
                self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)

if __name__ == "__main__":
    unittest.main()
