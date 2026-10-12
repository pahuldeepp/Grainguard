variable "telemetry_sink_credentials" {
  description = "Disposable Kafka SASL and ClickHouse writer credentials, supplied only during Terraform apply and written to the disposable Secrets Manager container."
  type        = map(string)
  sensitive   = true
  ephemeral   = true
  default     = {}
  validation {
    condition = length(var.telemetry_sink_credentials) == 0 || (
      toset(keys(var.telemetry_sink_credentials)) == toset(["KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD", "TELEMETRY_REPLAY_KAFKA_SASL_USERNAME", "TELEMETRY_REPLAY_KAFKA_SASL_PASSWORD"]) &&
      can(regex("^[A-Za-z0-9._-]{1,64}$", try(var.telemetry_sink_credentials["KAFKA_SASL_USERNAME"], ""))) &&
      length(try(var.telemetry_sink_credentials["KAFKA_SASL_PASSWORD"], "")) >= 24 &&
      can(regex("^[A-Za-z0-9._-]{1,64}$", try(var.telemetry_sink_credentials["CLICKHOUSE_USER"], ""))) &&
      length(try(var.telemetry_sink_credentials["CLICKHOUSE_PASSWORD"], "")) >= 24 &&
      try(var.telemetry_sink_credentials["TELEMETRY_REPLAY_KAFKA_SASL_USERNAME"], "") == "telemetry-replay" &&
      length(try(var.telemetry_sink_credentials["TELEMETRY_REPLAY_KAFKA_SASL_PASSWORD"], "")) >= 24
    )
    error_message = "Telemetry sink credentials must contain exactly scoped Kafka/ClickHouse usernames and passwords (passwords at least 24 characters)."
  }
}

variable "runtime_secret_values" {
  description = "Ephemeral runtime Secret payloads. Values are written only through Secrets Manager write-only arguments and are not stored in Terraform plans/state."
  type        = map(map(string))
  sensitive   = true
  ephemeral   = true
  default     = {}
  validation {
    condition     = alltrue([for values in values(var.runtime_secret_values) : length(values) > 0 && alltrue([for key, value in values : length(key) > 0 && length(value) > 0])])
    error_message = "Runtime secret values must be nonempty string maps with nonempty keys and values."
  }
  validation {
    condition     = var.enable_application_tree || alltrue([for name in keys(var.runtime_secret_values) : contains(var.secret_names, name)])
    error_message = "Every supplied runtime secret payload name must be included in secret_names; generated-secret payload names are rejected by the runtime materialization precondition."
  }
}

variable "audit_export_signing_material" {
  description = "Sensitive Ed25519 signing material for the disposable audit exporter. Supply matching PKCS#8 private and SPKI public PEMs, a key id, and a 32+ byte API link secret; worker startup validates the key pair."
  type        = map(string)
  sensitive   = true
  ephemeral   = true
  default     = {}
  validation {
    condition = length(var.audit_export_signing_material) == 0 || (
      toset(keys(var.audit_export_signing_material)) == toset(["AUDIT_EXPORT_PRIVATE_KEY_PEM", "AUDIT_EXPORT_PUBLIC_KEY_PEM", "AUDIT_EXPORT_PUBLIC_KEY_ID", "AUDIT_EXPORT_LINK_SECRET"]) &&
      length(try(var.audit_export_signing_material["AUDIT_EXPORT_PRIVATE_KEY_PEM"], "")) > 0 &&
      length(try(var.audit_export_signing_material["AUDIT_EXPORT_PUBLIC_KEY_PEM"], "")) > 0 &&
      can(regex("^[A-Za-z0-9._-]{1,64}$", try(var.audit_export_signing_material["AUDIT_EXPORT_PUBLIC_KEY_ID"], ""))) &&
      length(try(var.audit_export_signing_material["AUDIT_EXPORT_LINK_SECRET"], "")) >= 32
    )
    error_message = "Audit export signing material requires exactly the private/public PEM, valid key id, and 32+ character API link secret."
  }
}

locals {
  managed_dex_owner_uuid_hash = sha1("${var.cluster_name}:dex-first-owner")
  managed_dex_owner_uuid = join("-", [
    substr(local.managed_dex_owner_uuid_hash, 0, 8),
    substr(local.managed_dex_owner_uuid_hash, 8, 4),
    "5${substr(local.managed_dex_owner_uuid_hash, 13, 3)}",
    "${format("%x", 8 + parseint(substr(local.managed_dex_owner_uuid_hash, 16, 1), 16) % 4)}${substr(local.managed_dex_owner_uuid_hash, 17, 3)}",
    substr(local.managed_dex_owner_uuid_hash, 20, 12),
  ])
  runtime_bootstrap_role_keys_from_sql = toset(flatten(regexall("(?m)^\\\\getenv\\s+\\S+\\s+(\\S+)\\s*$", file("${path.module}/../../gitops/disposable/rds-bootstrap-chart/files/init-databases.sql"))))
  runtime_bootstrap_role_keys          = var.identity_mode == "managed-dex" ? local.runtime_bootstrap_role_keys_from_sql : setsubtract(local.runtime_bootstrap_role_keys_from_sql, toset(["DEX_DB_PASSWORD"]))
  # These credentials belong only to the central control and billing databases.
  # Operational shard bootstrap Secrets must never copy them to every shard.
  runtime_central_only_bootstrap_role_keys = toset([
    "CONTROL_DB_PASSWORD",
    "CONTROL_ENTITLEMENT_PROJECTOR_PASSWORD",
    "CONTROL_MIGRATOR_PASSWORD",
    "CONTROL_AUDIT_WORKER_PASSWORD",
    "CONTROL_BOOTSTRAP_WORKER_PASSWORD",
    "BILLING_DB_PASSWORD",
    "BILLING_MIGRATOR_PASSWORD",
    "BILLING_AUDIT_READER_PASSWORD",
    "DEX_DB_PASSWORD",
  ])
  runtime_shard_bootstrap_role_keys = setsubtract(local.runtime_bootstrap_role_keys, local.runtime_central_only_bootstrap_role_keys)
  runtime_secret_exact_keys = {
    greenguard-rds-bootstrap    = local.runtime_bootstrap_role_keys
    greenguard-rds-ca           = toset(["ca.pem"])
    greenguard-opensearch-ca    = toset(["ca.crt"])
    greenguard-kafka-ca         = toset(["ca.crt", "registry-ca.crt"])
    greenguard-opensearch-tls   = toset(["ca.crt", "node.crt", "node.key", "admin.crt", "admin.key"])
    greenguard-cassandra-tls    = toset(["server.p12", "keystore-password", "ca.crt"])
    greenguard-mqtt-broker      = toset(["tls.crt", "tls.key", "ca.crt", "passwords", "acl"])
    greenguard-data-credentials = toset(["REDIS_PASSWORD", "RABBITMQ_DEFAULT_USER", "RABBITMQ_DEFAULT_PASS", "RABBITMQ_ERLANG_COOKIE"])
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
  # Every caller of the placement/membership authority gets the one token
  # owned by the control-plane Secret. Do not accept per-service variants:
  # they can drift and make otherwise healthy sharded workloads fail closed.
  control_lookup_secret_consumers = toset([
    "bff-config", "gateway-config", "device-service-config", "read-api-config",
    "workflow-alerts-config", "notification-service-config", "telemetry-ingest-config", "billing-service-config",
    "projection-builder-config", "risk-engine-config", "jobs-worker-config",
    "hardware-service-config", "saga-api-config", "saga-worker-config",
    "tenant-control-plane-config",
  ])
  generated_runtime_values = var.enable_application_tree ? {
    "notification-contacts-projector-config" = {
      for key in ["KAFKA_BROKERS", "KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD", "SCHEMA_REGISTRY_URL", "SCHEMA_REGISTRY_USERNAME", "SCHEMA_REGISTRY_PASSWORD"] :
      key => try(var.runtime_secret_values["notification-service-config"][key], "")
    }
    # The heartbeat only needs its scoped Kafka producer settings. Keep Stripe,
    # billing database and webhook credentials in the billing service Secret.
    "entitlement-heartbeat-config" = {
      for key in ["KAFKA_BROKERS", "KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD"] :
      key => try(var.runtime_secret_values["billing-service-config"][key], "")
    }
  } : {}
  generated_projection_maintenance_values = var.enable_application_tree ? {
    for shard_id, shard in aws_db_instance.shard : "greenguard-${shard_id}-projection-history-maintenance-config" => {
      PROJECTION_MAINTENANCE_URL    = "postgresql://projection_history_maintainer:${replace(urlencode(try(var.shard_role_passwords[shard_id]["PROJECTION_HISTORY_MAINTAINER_PASSWORD"], "")), "+", "%20")}@${shard.address}:5432/greenguard_read?sslmode=verify-full&sslrootcert=/rds-ca/ca.pem"
      PROJECTION_HISTORY_SCHEMA     = "public"
      PROJECTION_HISTORY_HOT_WINDOW = "24h"
      PROJECTION_HISTORY_AHEAD_DAYS = "3"
    }
  } : {}
  generated_audit_export_values = var.enable_application_tree ? {
    "audit-export-worker-config" = {
      CONTROL_AUDIT_DATABASE_URL   = "postgresql://control_audit_worker:${replace(urlencode(try(var.runtime_secret_values["greenguard-rds-bootstrap"]["CONTROL_AUDIT_WORKER_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_control?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem"
      BILLING_AUDIT_DATABASE_URL   = "postgresql://billing_audit_reader:${replace(urlencode(try(var.runtime_secret_values["greenguard-rds-bootstrap"]["BILLING_AUDIT_READER_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_billing?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem"
      CONTROL_LOOKUP_TOKEN         = try(var.runtime_secret_values["tenant-control-plane-config"]["CONTROL_LOOKUP_TOKEN"], "")
      AUDIT_EXPORT_PRIVATE_KEY_PEM = try(var.audit_export_signing_material["AUDIT_EXPORT_PRIVATE_KEY_PEM"], "")
      AUDIT_EXPORT_PUBLIC_KEY_PEM  = try(var.audit_export_signing_material["AUDIT_EXPORT_PUBLIC_KEY_PEM"], "")
      AUDIT_EXPORT_PUBLIC_KEY_ID   = try(var.audit_export_signing_material["AUDIT_EXPORT_PUBLIC_KEY_ID"], "")
      AUDIT_EXPORT_S3_BUCKET       = aws_s3_bucket.audit_exports.id
      AUDIT_EXPORT_S3_REGION       = var.aws_region
    }
  } : {}
  generated_tenant_bootstrap_worker_values = var.enable_application_tree ? {
    "tenant-bootstrap-worker-config" = {
      CONTROL_BOOTSTRAP_DATABASE_URL = "postgresql://tenant_bootstrap_worker:${replace(urlencode(try(var.runtime_secret_values["greenguard-rds-bootstrap"]["CONTROL_BOOTSTRAP_WORKER_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_control?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem"
    }
  } : {}
  generated_telemetry_sink_values = var.enable_application_tree ? {
    "greenguard-telemetry-archive-config" = {
      KAFKA_BROKERS            = "kafka.greenguard.svc.cluster.local:29092"
      KAFKA_SECURITY_PROTOCOL  = "SASL_SSL"
      KAFKA_SASL_MECHANISM     = "PLAIN"
      KAFKA_TLS_CA_FILE        = "/etc/greenguard/kafka/ca.crt"
      TELEMETRY_ARCHIVE_BUCKET = aws_s3_bucket.telemetry_archive[0].id
      AWS_REGION               = var.aws_region
      KAFKA_SASL_USERNAME      = try(var.telemetry_sink_credentials["KAFKA_SASL_USERNAME"], "")
      KAFKA_SASL_PASSWORD      = try(var.telemetry_sink_credentials["KAFKA_SASL_PASSWORD"], "")
    }
    "greenguard-telemetry-clickhouse-config" = {
      KAFKA_BROKERS           = "kafka.greenguard.svc.cluster.local:29092"
      KAFKA_SECURITY_PROTOCOL = "SASL_SSL"
      KAFKA_SASL_MECHANISM    = "PLAIN"
      KAFKA_TLS_CA_FILE       = "/etc/greenguard/kafka/ca.crt"
      CLICKHOUSE_URL          = "http://greenguard-clickhouse.greenguard.svc.cluster.local:8123"
      KAFKA_SASL_USERNAME     = try(var.telemetry_sink_credentials["KAFKA_SASL_USERNAME"], "")
      KAFKA_SASL_PASSWORD     = try(var.telemetry_sink_credentials["KAFKA_SASL_PASSWORD"], "")
      CLICKHOUSE_USER         = try(var.telemetry_sink_credentials["CLICKHOUSE_USER"], "")
      CLICKHOUSE_PASSWORD     = try(var.telemetry_sink_credentials["CLICKHOUSE_PASSWORD"], "")
    }
    "greenguard-telemetry-replay-config" = {
      KAFKA_BROKERS            = "kafka.greenguard.svc.cluster.local:29092"
      KAFKA_SECURITY_PROTOCOL  = "SASL_SSL"
      KAFKA_SASL_MECHANISM     = "PLAIN"
      KAFKA_TLS_CA_FILE        = "/etc/greenguard/kafka/ca.crt"
      TELEMETRY_ARCHIVE_BUCKET = aws_s3_bucket.telemetry_archive[0].id
      AWS_REGION               = var.aws_region
      KAFKA_SASL_USERNAME      = try(var.telemetry_sink_credentials["TELEMETRY_REPLAY_KAFKA_SASL_USERNAME"], "")
      KAFKA_SASL_PASSWORD      = try(var.telemetry_sink_credentials["TELEMETRY_REPLAY_KAFKA_SASL_PASSWORD"], "")
    }
  } : {}
  generated_all_runtime_values = merge(local.generated_runtime_values, local.generated_projection_maintenance_values, local.generated_audit_export_values, local.generated_tenant_bootstrap_worker_values, local.generated_telemetry_sink_values)
  # Secret names are public, state-stable resource keys. Never derive instance
  # addresses or triggers from ephemeral payload values.
  runtime_secret_input_names = local.managed_secret_names
  runtime_secret_owned_values = {
    for name, values in merge(var.runtime_secret_values, local.generated_migration_values, local.generated_all_runtime_values) : name => merge(
      { for key, value in values : key => value if !contains([for config, profile in local.runtime_database_profiles : profile.key if !contains(["tenant-control-plane-config", "billing-service-config"], config)], key) },
      contains(local.control_lookup_secret_consumers, name) ? {
        CONTROL_LOOKUP_TOKEN = try(var.runtime_secret_values["tenant-control-plane-config"]["CONTROL_LOOKUP_TOKEN"], "")
      } : {},
      name == "tenant-control-plane-config" ? { CONTROL_ENTITLEMENT_PROJECTOR_URL = "postgresql://control_entitlement_projector:${replace(urlencode(try(var.runtime_secret_values["greenguard-rds-bootstrap"]["CONTROL_ENTITLEMENT_PROJECTOR_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_control?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem" } : {},
      name == "notification-contacts-projector-config" ? { NOTIFICATION_STATE_TABLE = aws_dynamodb_table.notification_state[0].name, AWS_REGION = var.aws_region } : {},
      name == "eventbridge-bridge-config" ? { AWS_REGION = var.aws_region, AWS_ACCOUNT_ID = var.target_account_id } : {},
      name == "billing-service-config" ? {
        BILLING_RETURN_ORIGINS = "https://${aws_cloudfront_distribution.web.domain_name}"
      } : {},
      name == "greenguard-dex-config" && var.identity_mode == "managed-dex" ? {
        DEX_ISSUER              = local.managed_dex_issuer
        DEX_DATABASE_HOST       = aws_db_instance.postgres.address
        DEX_DATABASE_PASSWORD   = try(var.runtime_secret_values["greenguard-rds-bootstrap"]["DEX_DB_PASSWORD"], "")
        DEX_DASHBOARD_ORIGIN    = "https://${aws_cloudfront_distribution.web.domain_name}"
        DEX_DASHBOARD_CLIENT_ID = local.managed_dex_public.web_client_id
        DEX_MOBILE_CLIENT_ID    = local.managed_dex_public.mobile_client_id
        DEX_FIRST_ADMIN_USER_ID = local.managed_dex_owner_uuid
      } : {},
      name == "bff-config" && var.ml_synthetic_enabled ? {
        ML_OPERATIONS_URL   = "http://ml-scoring-synthetic.ml-synthetic.svc.cluster.local:8080"
        ML_OPERATIONS_TOKEN = base64decode(var.ml_synthetic_secret_payloads["ml-scoring-runtime"]["operations-token"])
      } : {},
      name == "tenant-control-plane-config" && var.enable_application_tree ? {
        AUDIT_EXPORT_S3_BUCKET      = aws_s3_bucket.audit_exports.id
        AUDIT_EXPORT_S3_REGION      = var.aws_region
        AUDIT_EXPORT_PUBLIC_KEY_PEM = try(var.audit_export_signing_material["AUDIT_EXPORT_PUBLIC_KEY_PEM"], "")
        AUDIT_EXPORT_LINK_SECRET    = try(var.audit_export_signing_material["AUDIT_EXPORT_LINK_SECRET"], "")
        BILLING_DATABASE_URL        = "postgresql://billing_app:${replace(urlencode(try(var.runtime_secret_values["greenguard-rds-bootstrap"]["BILLING_DB_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_billing?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem"
      } : {},
      contains(["tenant-control-plane-config", "billing-service-config"], name) ? {
        (local.runtime_database_profiles[name].key) = "postgresql://${local.runtime_database_profiles[name].role}:${replace(urlencode(try(var.runtime_secret_values["greenguard-rds-bootstrap"][local.runtime_database_profiles[name].password_key], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/${local.runtime_database_profiles[name].database}?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem"
      } : {}
    )
  }
  runtime_secret_version_ids = merge(
    { for name, version in aws_secretsmanager_secret_version.runtime : name => version.version_id },
    local.managed_stripe_webhook ? {
      "billing-service-config" = one([for version in data.aws_secretsmanager_secret_versions.stripe_webhook[0].versions : version.version_id if contains(version.version_stages, "AWSCURRENT")])
    } : {},
  )
  runtime_secret_sync_scope = {
    account_id       = var.target_account_id
    region           = var.aws_region
    environment      = var.environment
    cluster          = var.cluster_name
    rds_instance     = aws_db_instance.postgres.identifier
    namespace        = "greenguard"
    versions         = merge(local.runtime_secret_version_ids, local.shard_registry_secret_versions, local.shard_bootstrap_secret_versions, local.tenant_bootstrap_secret_versions, local.shard_data_secret_versions, local.projector_registry_secret_versions)
    sources          = merge({ for name, secret in aws_secretsmanager_secret.runtime : name => secret.name if contains(local.runtime_secret_input_names, name) }, local.shard_registry_secret_sources, local.shard_bootstrap_secret_sources, local.tenant_bootstrap_secret_sources, local.shard_data_secret_sources, local.projector_registry_secret_sources)
    shard_bootstraps = local.shard_bootstrap_scope
    master_version   = try(one([for version in data.aws_secretsmanager_secret_versions.runtime_master[0].versions : version.version_id if contains(version.version_stages, "AWSCURRENT")]), "")
  }
}

resource "aws_secretsmanager_secret_version" "runtime" {
  depends_on = [
    terraform_data.destroy_inventory_sentinel,
    terraform_data.ml_synthetic_secret_guard,
  ]
  for_each  = local.managed_secret_names
  secret_id = aws_secretsmanager_secret.runtime[each.key].id
  # A name/payload mismatch must reach the explanatory precondition below,
  # rather than fail first with an opaque invalid map index.
  secret_string_wo         = try(jsonencode(local.runtime_secret_owned_values[each.key]), jsonencode({}))
  secret_string_wo_version = lookup(var.secret_version_counters, "runtime/${each.key}", 1)
  lifecycle {
    precondition {
      condition     = contains(local.managed_secret_names, each.key) && !contains(["prod", "production"], lower(var.environment))
      error_message = "Runtime values require approved Terraform-owned containers in a non-production disposable environment."
    }
    precondition {
      condition = nonsensitive(toset(keys(var.runtime_secret_values))) == setsubtract(
        local.managed_secret_names,
        setunion(toset(keys(local.generated_migration_values)), toset(keys(local.generated_all_runtime_values)))
        ) && length(setintersection(
          nonsensitive(toset(keys(var.runtime_secret_values))),
          setunion(toset(keys(local.generated_migration_values)), toset(keys(local.generated_all_runtime_values)))
      )) == 0
      error_message = "Application bootstrap requires exactly one caller payload for every approved non-generated runtime secret, with no missing, extra, or generated-secret payload names."
    }
    precondition {
      condition     = !contains(keys(local.runtime_secret_exact_keys), each.key) || try(toset(keys(var.runtime_secret_values[each.key])) == local.runtime_secret_exact_keys[each.key], false)
      error_message = "Runtime bootstrap, CA and TLS secret keys must exactly match the approved role/material profile."
    }
    precondition {
      condition = each.key != "greenguard-dex-config" || (
        var.identity_mode == "managed-dex" &&
        can(regex("^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", try(var.runtime_secret_values[each.key]["DEX_FIRST_ADMIN_EMAIL"], ""))) &&
        can(regex("^\\$2[aby]\\$[0-3][0-9]\\$[./A-Za-z0-9]{53}$", try(var.runtime_secret_values[each.key]["DEX_FIRST_ADMIN_PASSWORD_HASH"], "")))
      )
      error_message = "greenguard-dex-config requires an operator-selected first-admin email and a valid bcrypt hash; do not use local demo users or plaintext passwords."
    }
    precondition {
      condition = each.key != "billing-service-config" || (
        can(regex("^(sk|rk)_test_[A-Za-z0-9]+$", try(var.runtime_secret_values[each.key]["STRIPE_API_KEY"], ""))) &&
        (local.managed_stripe_webhook || (
          length(split(",", try(var.runtime_secret_values[each.key]["STRIPE_WEBHOOK_SECRETS"], ""))) >= 1 &&
          length(split(",", try(var.runtime_secret_values[each.key]["STRIPE_WEBHOOK_SECRETS"], ""))) <= 2 &&
          alltrue([for secret in split(",", try(var.runtime_secret_values[each.key]["STRIPE_WEBHOOK_SECRETS"], "")) : can(regex("^whsec_[A-Za-z0-9]+$", trimspace(secret)))])
        )) &&
        can(regex("^[A-Za-z0-9+/]{43}=$", try(var.runtime_secret_values[each.key]["BILLING_INBOX_ENCRYPTION_KEY"], "")))
      )
      error_message = "billing-service-config requires a Stripe test API key and base64 32-byte inbox key; unmanaged webhooks also require one or two signing secrets. Managed webhook provisioning supplies the final signer before Kubernetes secret sync."
    }
    precondition {
      condition = each.key != "entitlement-heartbeat-config" || (
        var.enable_application_tree &&
        try(var.runtime_secret_values["billing-service-config"]["KAFKA_SASL_USERNAME"], "") == "billing-service" &&
        length(trimspace(try(var.runtime_secret_values["billing-service-config"]["KAFKA_BROKERS"], ""))) > 0 &&
        length(try(var.runtime_secret_values["billing-service-config"]["KAFKA_SASL_PASSWORD"], "")) > 0 &&
        !can(regex("[\"\\\\\\r\\n]", try(var.runtime_secret_values["billing-service-config"]["KAFKA_SASL_PASSWORD"], "")))
      )
      error_message = "entitlement-heartbeat-config is generated from the billing Kafka principal and requires only its broker, username, and password settings."
    }
    precondition {
      condition = !contains(["greenguard-telemetry-archive-config", "greenguard-telemetry-clickhouse-config", "greenguard-telemetry-replay-config"], each.key) || (
        var.enable_application_tree &&
        toset(keys(var.telemetry_sink_credentials)) == toset(["KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD", "TELEMETRY_REPLAY_KAFKA_SASL_USERNAME", "TELEMETRY_REPLAY_KAFKA_SASL_PASSWORD"]) &&
        length(try(var.telemetry_sink_credentials["KAFKA_SASL_PASSWORD"], "")) >= 24 &&
        length(try(var.telemetry_sink_credentials["CLICKHOUSE_PASSWORD"], "")) >= 24 &&
        try(var.telemetry_sink_credentials["TELEMETRY_REPLAY_KAFKA_SASL_USERNAME"], "") == "telemetry-replay" &&
        length(try(var.telemetry_sink_credentials["TELEMETRY_REPLAY_KAFKA_SASL_PASSWORD"], "")) >= 24
      )
      error_message = "The disposable telemetry sinks require complete Kafka and ClickHouse credentials."
    }
    precondition {
      condition     = each.key != "notification-contacts-projector-config" || alltrue([for key in ["KAFKA_BROKERS", "KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD", "SCHEMA_REGISTRY_URL", "SCHEMA_REGISTRY_USERNAME", "SCHEMA_REGISTRY_PASSWORD"] : try(length(trimspace(var.runtime_secret_values["notification-service-config"][key])) > 0, false)])
      error_message = "The contacts projector needs broker and Registry credentials copied from notification-service-config."
    }
    precondition {
      condition     = each.key != "tenant-control-plane-config" || try(length(var.runtime_secret_values[each.key]["CONTROL_LOOKUP_TOKEN"]) >= 32, false)
      error_message = "The canonical control-plane lookup token must contain at least 32 characters."
    }
    precondition {
      condition = each.key != "greenguard-data-credentials" || (
        try(var.runtime_secret_values[each.key]["RABBITMQ_DEFAULT_USER"], "") == "greenguard" &&
        alltrue([for key in ["REDIS_PASSWORD", "RABBITMQ_DEFAULT_PASS", "RABBITMQ_ERLANG_COOKIE"] :
          can(regex("^[A-Za-z0-9_-]{32,128}$", try(var.runtime_secret_values[each.key][key], "")))
        ]) &&
        length(toset([for key in ["REDIS_PASSWORD", "RABBITMQ_DEFAULT_PASS", "RABBITMQ_ERLANG_COOKIE"] : try(var.runtime_secret_values[each.key][key], "")])) == 3
      )
      error_message = "Redis/RabbitMQ require the scoped greenguard user and independent 32-128 character URL-safe credentials."
    }
    precondition {
      condition     = each.key != "audit-export-worker-config" || (toset(keys(var.audit_export_signing_material)) == toset(["AUDIT_EXPORT_PRIVATE_KEY_PEM", "AUDIT_EXPORT_PUBLIC_KEY_PEM", "AUDIT_EXPORT_PUBLIC_KEY_ID", "AUDIT_EXPORT_LINK_SECRET"]) && try(length(var.runtime_secret_values["tenant-control-plane-config"]["CONTROL_LOOKUP_TOKEN"]) >= 32, false) && try(length(var.runtime_secret_values["greenguard-rds-bootstrap"]["CONTROL_AUDIT_WORKER_PASSWORD"]) > 0, false) && try(length(var.runtime_secret_values["greenguard-rds-bootstrap"]["BILLING_AUDIT_READER_PASSWORD"]) > 0, false))
      error_message = "Audit export needs a complete Ed25519 key contract, control lookup token, and dedicated central database role passwords."
    }
  }
}

resource "terraform_data" "runtime_secret_sync" {
  count            = var.enable_application_tree ? 1 : 0
  input            = local.runtime_secret_sync_scope
  triggers_replace = local.runtime_secret_sync_scope
  depends_on = [helm_release.greenguard_namespace, aws_eks_node_group.general, aws_eks_access_policy_association.cluster_admin, aws_db_instance.postgres, aws_secretsmanager_secret_version.runtime, aws_secretsmanager_secret_version.shard_routing, aws_secretsmanager_secret_version.shard_bootstrap, aws_secretsmanager_secret_version.tenant_bootstrap, aws_secretsmanager_secret_version.shard_data, aws_secretsmanager_secret_version.projector_routing, terraform_data.runtime_secret_cleanup,
    terraform_data.destroy_inventory_sentinel,
  ]
  lifecycle {
    precondition {
      condition     = toset(keys(var.runtime_secret_values)) == setsubtract(local.managed_secret_names, setunion(toset(keys(local.generated_migration_values)), toset(keys(local.generated_all_runtime_values)))) && length(setintersection(toset(keys(var.runtime_secret_values)), setunion(toset(keys(local.generated_migration_values)), toset(keys(local.generated_all_runtime_values))))) == 0
      error_message = "Application bootstrap requires Terraform-owned values for every approved secret container and no extra values."
    }
    precondition {
      condition = alltrue([for key in keys(var.secret_version_counters) :
        !startswith(key, "runtime/") || contains(local.managed_secret_names, trimprefix(key, "runtime/"))
      ])
      error_message = "Runtime secret-version counters must reference a managed Secret container."
    }
  }
  provisioner "local-exec" {
    command     = "python3 ${path.module}/../../gitops/disposable/runtime-secret-lifecycle.py apply"
    environment = { GG_RUNTIME_SECRET_SCOPE = jsonencode(self.input) }
    quiet       = true
  }
}

# RDS rotates its managed master credential independently of supplied role
# passwords. This data source returns version metadata only; the singular
# secret-version data source also returns SecretString and persists it.
data "aws_secretsmanager_secret_versions" "runtime_master" {
  count              = var.enable_application_tree ? 1 : 0
  secret_id          = aws_db_instance.postgres.master_user_secret[0].secret_arn
  include_deprecated = false
}

# Keep cleanup ownership in a resource with no create provisioner. Terraform
# skips destroy provisioners on tainted resources; a failed partial sync must
# never taint the resource responsible for cleaning the already-created subset.
resource "terraform_data" "runtime_secret_cleanup" {
  count            = var.enable_application_tree ? 1 : 0
  input            = { scope = local.runtime_secret_sync_scope, runner = abspath("${path.module}/../../gitops/disposable/runtime-secret-lifecycle.py") }
  triggers_replace = local.runtime_secret_sync_scope
  depends_on = [helm_release.greenguard_namespace, aws_eks_node_group.general, aws_eks_access_policy_association.cluster_admin, aws_db_instance.postgres, aws_secretsmanager_secret_version.runtime, aws_secretsmanager_secret_version.shard_routing, aws_secretsmanager_secret_version.shard_bootstrap, aws_secretsmanager_secret_version.tenant_bootstrap, aws_secretsmanager_secret_version.shard_data, aws_secretsmanager_secret_version.projector_routing,
    terraform_data.destroy_inventory_sentinel,
  ]
  provisioner "local-exec" {
    when        = destroy
    command     = "python3 ${self.input.runner} destroy"
    environment = { GG_RUNTIME_SECRET_SCOPE = jsonencode(self.input.scope) }
    quiet       = true
  }
}
