# A Terraform apply must own the application tree as well as the AWS substrate.
# Post-deployment health and acceptance are checked by the deployed workload
# acceptance resource after Argo has reconciled the pinned application tree.
resource "terraform_data" "deployment_readiness_gate" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  input      = { application_tree_enabled = var.enable_application_tree }

  lifecycle {
    precondition {
      condition     = var.enable_application_tree
      error_message = "Refusing an infrastructure-only GreenGuard apply. Enable the complete Argo application tree and provide its exact Git revision, immutable runtime/migration/data-plane/observability image digests, OIDC configuration and required ephemeral secret payloads. Terraform then waits for Argo workloads and migration acceptance; user journeys and physical iPhone acceptance remain explicit post-deployment gates."
    }
  }
}

# Persist the exact inventory scope in Terraform state before a destroy. The
# verified wrapper reads this output and refuses caller-supplied mismatches.
output "disposable_cell_identity" {
  value = {
    region       = var.aws_region
    environment  = var.environment
    cluster_name = var.cluster_name
    account_id   = var.target_account_id
  }
}
