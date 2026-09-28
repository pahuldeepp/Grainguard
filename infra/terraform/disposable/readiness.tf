# This root has a partial AWS foundation, data store, HTTPS edge and OIDC
# issuer. Keep ordinary plan and apply fail-closed until controller bootstrap is
# proven, all data services, migrations, application releases, tenant
# enrollment and acceptance gates are actually owned by the deployment.
# Controller archive integrity has a local checksum check, but live controller
# and workload health still need proof. A user deliberately
# inspecting these resources can opt in to an incomplete plan; this switch
# must never be used as evidence that GreenGuard is deployable.
variable "allow_incomplete_foundation_plan" {
  description = "Explicitly acknowledge that this root is an incomplete deployment plan. Never set for a full GreenGuard deployment."
  type        = bool
  default     = false
}

resource "terraform_data" "deployment_readiness_gate" {
  # When the deliberate incomplete-plan override is true, this resource is
  # absent from state. A later destroy with the default false therefore has
  # no gate instance to evaluate or create: destroy only removes state objects.
  count = var.allow_incomplete_foundation_plan ? 0 : 1

  lifecycle {
    precondition {
      condition     = var.allow_incomplete_foundation_plan
      error_message = "This disposable root does not yet deploy GreenGuard end to end. Controller and data-service bootstrap, populated Secrets, migrations, application health, Stage 11 telemetry, real-user tenant enrollment and web/iPhone acceptance need live proof. Audit export is an additional first-cell blocker: Standard/Enterprise advertise audit_export, but the exporter worker, signing-key contract, and end-to-end S3 path are not deployed. Do not apply it as a complete cell."
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
