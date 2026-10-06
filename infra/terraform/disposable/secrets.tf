# Terraform owns approved containers and runtime-secret versions. A zero-day
# recovery window requests immediate deletion for this disposable environment.
resource "aws_secretsmanager_secret" "runtime" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each   = var.secret_names

  name                    = "greenguard/${var.environment}/${each.value}"
  recovery_window_in_days = 0

  tags = { Cell = var.cluster_name, RuntimeSecretOwner = "greenguard-disposable-secret-sync" }
}

variable "secret_names" {
  description = "Public names of approved runtime secret containers. Payload values are ephemeral and are not used as Terraform resource keys."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for name in var.secret_names : can(regex("^[a-z0-9][a-z0-9/_-]{0,120}$", name))])
    error_message = "secret_names must contain only lowercase path names."
  }
}

variable "secret_version_counters" {
  description = "Public, nonsecret write-only Secrets Manager version counters. Increment the scoped key when its ephemeral payload changes; omitted keys use initial version 1."
  type        = map(number)
  default     = {}
  validation {
    condition     = alltrue([for version in values(var.secret_version_counters) : version >= 1 && version == floor(version)])
    error_message = "Secret version counters must be positive integers."
  }
  validation {
    condition     = alltrue([for key in keys(var.secret_version_counters) : can(regex("^(runtime|shard-routing|shard-bootstrap|shard-data|projector-routing|tenant-bootstrap)/[a-z0-9/_-]+$", key))])
    error_message = "Secret version counters must use a recognized nonsecret scope/name key."
  }
  validation {
    condition = alltrue([for key in keys(var.secret_version_counters) : (
      startswith(key, "runtime/") ? contains(var.secret_names, trimprefix(key, "runtime/")) :
      startswith(key, "shard-routing/") ? contains([
        "device-service", "telemetry-ingest", "projection-builder", "risk-engine",
        "workflow-alerts", "jobs-worker", "notification-service", "saga-orchestrator",
        "hardware-service", "read-api", "audit-export-worker",
      ], trimprefix(key, "shard-routing/")) :
      startswith(key, "shard-bootstrap/") ? contains(["s1", "s2", "s3", "s4"], trimprefix(key, "shard-bootstrap/")) :
      startswith(key, "tenant-bootstrap/") ? contains(["s1", "s2", "s3", "s4"], trimprefix(key, "tenant-bootstrap/")) :
      startswith(key, "shard-data/") ? contains(flatten([for shard in ["s1", "s2", "s3", "s4"] : ["${shard}/cdc", "${shard}/pgbouncer"]]), trimprefix(key, "shard-data/")) :
      startswith(key, "projector-routing/") ? contains([
        "read-entitlement-projector", "inventory-projector", "telemetry-entitlement-projector",
      ], trimprefix(key, "projector-routing/")) : false
    )])
    error_message = "Each secret version counter must name an actual runtime secret, shard bootstrap/data secret, or approved routing secret; unknown scope/name keys are rejected."
  }
}

output "secret_arns" {
  value = { for name, secret in aws_secretsmanager_secret.runtime : name => secret.arn }
}
