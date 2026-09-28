variable "runtime_secret_values" {
  description = "Explicit runtime secret string maps, including real upstream credentials and CA/key material. Sensitive values enter encrypted Terraform state; use an approved encrypted backend. Terraform overrides environment-owned endpoints."
  type        = map(map(string))
  sensitive   = true
  default     = {}
  validation {
    condition     = alltrue([for values in values(var.runtime_secret_values) : length(values) > 0 && alltrue([for key, value in values : length(key) > 0 && length(value) > 0])])
    error_message = "Runtime secret values must be nonempty string maps with nonempty keys and values."
  }
}

locals {
  runtime_bootstrap_role_keys = toset(flatten(regexall("(?m)^\\\\getenv\\s+\\S+\\s+(\\S+)\\s*$", file("${path.module}/../../gitops/disposable/rds-bootstrap-chart/files/init-databases.sql"))))
  runtime_secret_exact_keys = {
    greenguard-rds-bootstrap  = local.runtime_bootstrap_role_keys
    greenguard-rds-ca         = toset(["ca.pem"])
    greenguard-opensearch-ca  = toset(["ca.crt"])
    greenguard-kafka-ca       = toset(["ca.crt", "registry-ca.crt"])
    greenguard-opensearch-tls = toset(["ca.crt", "node.crt", "node.key", "admin.crt", "admin.key"])
    greenguard-cassandra-tls  = toset(["server.p12", "keystore-password", "ca.crt"])
    greenguard-mqtt-broker    = toset(["tls.crt", "tls.key", "ca.crt", "passwords", "acl"])
  }

  runtime_database_profiles = {
    "device-service-config"       = { key = "INVENTORY_DATABASE_URL", role = "inventory_app", database = "greenguard_inventory", password_key = "INVENTORY_DB_PASSWORD" }
    "telemetry-ingest-config"     = { key = "TELEMETRY_DATABASE_URL", role = "telemetry_app", database = "greenguard_telemetry", password_key = "TELEMETRY_DB_PASSWORD" }
    "projection-builder-config"   = { key = "PROJECTION_DATABASE_URL", role = "projection_app", database = "greenguard_read", password_key = "PROJECTION_DB_PASSWORD" }
    "read-api-config"             = { key = "READ_QUERY_DATABASE_URL", role = "read_query", database = "greenguard_read", password_key = "READ_QUERY_DB_PASSWORD" }
    "risk-engine-config"          = { key = "RISK_DATABASE_URL", role = "risk_app", database = "greenguard_risk", password_key = "RISK_DB_PASSWORD" }
    "jobs-worker-config"          = { key = "JOBS_DATABASE_URL", role = "jobs_app", database = "greenguard_jobs", password_key = "JOBS_DB_PASSWORD" }
    "notification-service-config" = { key = "NOTIFICATIONS_DATABASE_URL", role = "notifications_app", database = "greenguard_notifications", password_key = "NOTIFICATIONS_DB_PASSWORD" }
    "workflow-alerts-config"      = { key = "ALERTS_DATABASE_URL", role = "alerts_app", database = "greenguard_alerts", password_key = "ALERTS_DB_PASSWORD" }
    "saga-api-config"             = { key = "SAGA_DATABASE_URL", role = "saga_app", database = "greenguard_sagas", password_key = "SAGA_DB_PASSWORD" }
    "saga-worker-config"          = { key = "SAGA_DATABASE_URL", role = "saga_app", database = "greenguard_sagas", password_key = "SAGA_DB_PASSWORD" }
    "hardware-service-config"     = { key = "HARDWARE_DATABASE_URL", role = "hardware_app", database = "greenguard_hardware", password_key = "HARDWARE_DB_PASSWORD" }
    "tenant-control-plane-config" = { key = "CONTROL_DATABASE_URL", role = "control_app", database = "greenguard_control", password_key = "CONTROL_DB_PASSWORD" }
    "billing-service-config"      = { key = "BILLING_DATABASE_URL", role = "billing_app", database = "greenguard_billing", password_key = "BILLING_DB_PASSWORD" }
  }
  generated_runtime_values = var.enable_application_tree ? {
    "notification-contacts-projector-config" = {
      for key in ["KAFKA_BROKERS", "KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD", "SCHEMA_REGISTRY_URL", "SCHEMA_REGISTRY_USERNAME", "SCHEMA_REGISTRY_PASSWORD"] :
      key => try(var.runtime_secret_values["notification-service-config"][key], "")
    }
  } : {}
  runtime_secret_input_names = setunion(nonsensitive(toset(keys(var.runtime_secret_values))), nonsensitive(toset(keys(local.generated_migration_values))), nonsensitive(toset(keys(local.generated_runtime_values))))
  runtime_secret_owned_values = {
    for name, values in merge(var.runtime_secret_values, local.generated_migration_values, local.generated_runtime_values) : name => merge(
      { for key, value in values : key => value if !contains([for config, profile in local.runtime_database_profiles : profile.key if !contains(["tenant-control-plane-config", "billing-service-config"], config)], key) },
      name == "tenant-control-plane-config" ? { CONTROL_ENTITLEMENT_PROJECTOR_URL = "postgresql://control_entitlement_projector:${replace(urlencode(try(var.runtime_secret_values["greenguard-rds-bootstrap"]["CONTROL_ENTITLEMENT_PROJECTOR_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_control?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem" } : {},
      name == "notification-contacts-projector-config" ? { NOTIFICATION_STATE_TABLE = aws_dynamodb_table.notification_state[0].name, AWS_REGION = var.aws_region } : {},
      name == "eventbridge-bridge-config" ? { AWS_REGION = var.aws_region, AWS_ACCOUNT_ID = var.target_account_id } : {},
      contains(["tenant-control-plane-config", "billing-service-config"], name) ? {
        (local.runtime_database_profiles[name].key) = "postgresql://${local.runtime_database_profiles[name].role}:${replace(urlencode(try(var.runtime_secret_values["greenguard-rds-bootstrap"][local.runtime_database_profiles[name].password_key], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/${local.runtime_database_profiles[name].database}?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem"
      } : {}
    )
  }
  runtime_secret_version_ids = { for name, version in aws_secretsmanager_secret_version.runtime : name => version.version_id }
  runtime_secret_sync_scope = {
    account_id       = var.target_account_id
    region           = var.aws_region
    environment      = var.environment
    cluster          = var.cluster_name
    rds_instance     = aws_db_instance.postgres.identifier
    namespace        = "greenguard"
    versions         = merge(local.runtime_secret_version_ids, local.shard_registry_secret_versions, local.shard_bootstrap_secret_versions, local.shard_data_secret_versions, local.projector_registry_secret_versions)
    sources          = merge({ for name, secret in aws_secretsmanager_secret.runtime : name => secret.name if contains(local.runtime_secret_input_names, name) }, local.shard_registry_secret_sources, local.shard_bootstrap_secret_sources, local.shard_data_secret_sources, local.projector_registry_secret_sources)
    shard_bootstraps = local.shard_bootstrap_scope
    master_version   = try(data.aws_secretsmanager_secret_version.runtime_master[0].version_id, "")
  }
}

resource "aws_secretsmanager_secret_version" "runtime" {
  for_each      = local.runtime_secret_input_names
  secret_id     = aws_secretsmanager_secret.runtime[each.key].id
  secret_string = jsonencode(local.runtime_secret_owned_values[each.key])
  lifecycle {
    precondition {
      condition     = contains(var.secret_names, each.key) && !contains(["prod", "production"], lower(var.environment))
      error_message = "Runtime values require approved Terraform-owned containers in a non-production disposable environment."
    }
    precondition {
      condition     = !contains(keys(local.runtime_secret_exact_keys), each.key) || try(toset(keys(var.runtime_secret_values[each.key])) == local.runtime_secret_exact_keys[each.key], false)
      error_message = "Runtime bootstrap, CA and TLS secret keys must exactly match the approved role/material profile."
    }
    precondition {
      condition     = each.key != "notification-contacts-projector-config" || alltrue([for key in ["KAFKA_BROKERS", "KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD", "SCHEMA_REGISTRY_URL", "SCHEMA_REGISTRY_USERNAME", "SCHEMA_REGISTRY_PASSWORD"] : try(length(trimspace(var.runtime_secret_values["notification-service-config"][key])) > 0, false)])
      error_message = "The contacts projector needs broker and Registry credentials copied from notification-service-config."
    }
  }
}

resource "terraform_data" "runtime_secret_sync" {
  count            = var.enable_application_tree ? 1 : 0
  input            = local.runtime_secret_sync_scope
  triggers_replace = local.runtime_secret_sync_scope
  depends_on       = [helm_release.greenguard_namespace, aws_eks_node_group.general, aws_eks_access_policy_association.cluster_admin, aws_db_instance.postgres, aws_secretsmanager_secret_version.runtime, aws_secretsmanager_secret_version.shard_routing, aws_secretsmanager_secret_version.shard_bootstrap, aws_secretsmanager_secret_version.shard_data, aws_secretsmanager_secret_version.projector_routing, terraform_data.runtime_secret_cleanup]
  lifecycle {
    precondition {
      condition     = local.runtime_secret_input_names == var.secret_names && length(setintersection(nonsensitive(toset(keys(var.runtime_secret_values))), nonsensitive(toset(keys(local.generated_migration_values))))) == 0 && length(setintersection(nonsensitive(toset(keys(var.runtime_secret_values))), nonsensitive(toset(keys(local.generated_runtime_values))))) == 0
      error_message = "Application bootstrap requires Terraform-owned values for every approved secret container and no extra values."
    }
  }
  provisioner "local-exec" {
    command     = "python3 ${path.module}/../../gitops/disposable/runtime-secret-lifecycle.py apply"
    environment = { GG_RUNTIME_SECRET_SCOPE = jsonencode(self.input) }
    quiet       = true
  }
}

# RDS rotates its managed master credential independently of supplied role
# passwords. Tracking only its public version ID resynchronizes bootstrap.
data "aws_secretsmanager_secret_version" "runtime_master" {
  count         = var.enable_application_tree ? 1 : 0
  secret_id     = aws_db_instance.postgres.master_user_secret[0].secret_arn
  version_stage = "AWSCURRENT"
}

# Keep cleanup ownership in a resource with no create provisioner. Terraform
# skips destroy provisioners on tainted resources; a failed partial sync must
# never taint the resource responsible for cleaning the already-created subset.
resource "terraform_data" "runtime_secret_cleanup" {
  count            = var.enable_application_tree ? 1 : 0
  input            = { scope = local.runtime_secret_sync_scope, runner = abspath("${path.module}/../../gitops/disposable/runtime-secret-lifecycle.py") }
  triggers_replace = local.runtime_secret_sync_scope
  depends_on       = [helm_release.greenguard_namespace, aws_eks_node_group.general, aws_eks_access_policy_association.cluster_admin, aws_db_instance.postgres, aws_secretsmanager_secret_version.runtime, aws_secretsmanager_secret_version.shard_routing, aws_secretsmanager_secret_version.shard_bootstrap, aws_secretsmanager_secret_version.shard_data, aws_secretsmanager_secret_version.projector_routing]
  provisioner "local-exec" {
    when        = destroy
    command     = "python3 ${self.input.runner} destroy"
    environment = { GG_RUNTIME_SECRET_SCOPE = jsonencode(self.input.scope) }
    quiet       = true
  }
}
