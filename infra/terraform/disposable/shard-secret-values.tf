variable "shard_role_passwords" {
  description = "Sensitive complete bootstrap role/password maps for exactly s1-s4. These passwords also derive migration URLs; no endpoint or role is caller controlled."
  type        = map(map(string))
  sensitive   = true
  default     = {}
  validation {
    condition     = length(var.shard_role_passwords) == 0 || (toset(keys(var.shard_role_passwords)) == toset(["s1", "s2", "s3", "s4"]) && alltrue([for passwords in values(var.shard_role_passwords) : alltrue([for password in values(passwords) : length(password) > 0])]))
    error_message = "Shard passwords require all four shards and nonempty values."
  }
}

variable "shard_registry_passwords" {
  description = "Sensitive service => s1-s4 password maps for exactly the ten shard-routing services. Each must equal the service's actual bootstrap role password. Terraform derives immutable incarnations and endpoints."
  type        = map(map(string))
  sensitive   = true
  default     = {}
}

locals {
  migration_owner_contract = { for owner in jsondecode(regex("fromJsonArray `([^`]+)`", file("${path.module}/../../gitops/disposable/applications-chart/templates/_owner-migrations.tpl"))[0]) : owner.name => owner }
  shard_service_profiles = {
    device-service       = { role = "inventory_app", database = "greenguard_inventory", password_key = "INVENTORY_DB_PASSWORD" }
    telemetry-ingest     = { role = "telemetry_app", database = "greenguard_telemetry", password_key = "TELEMETRY_DB_PASSWORD" }
    projection-builder   = { role = "projection_app", database = "greenguard_read", password_key = "PROJECTION_DB_PASSWORD" }
    risk-engine          = { role = "risk_app", database = "greenguard_risk", password_key = "RISK_DB_PASSWORD" }
    workflow-alerts      = { role = "alerts_app", database = "greenguard_alerts", password_key = "ALERTS_DB_PASSWORD" }
    jobs-worker          = { role = "jobs_app", database = "greenguard_jobs", password_key = "JOBS_DB_PASSWORD" }
    notification-service = { role = "notifications_app", database = "greenguard_notifications", password_key = "NOTIFICATIONS_DB_PASSWORD" }
    saga-orchestrator    = { role = "saga_app", database = "greenguard_sagas", password_key = "SAGA_DB_PASSWORD" }
    hardware-service     = { role = "hardware_app", database = "greenguard_hardware", password_key = "HARDWARE_DB_PASSWORD" }
    read-api             = { role = "read_query", database = "greenguard_read", password_key = "READ_QUERY_DB_PASSWORD" }
  }
  # resource_id is RDS's immutable DbiResourceId, unlike its reusable identifier.
  # uuidv5 is deterministic and changes when the physical instance is replaced.
  shard_incarnations = { for shard_id, shard in aws_db_instance.shard : shard_id => uuidv5("url", "arn:aws:rds:${var.aws_region}:${var.target_account_id}:db-resource:${shard.resource_id}") }
  generated_migration_values = var.enable_application_tree ? merge(
    { for owner, profile in local.migration_owner_contract : "greenguard-${owner}-migration" => {
      (profile.key) = "postgresql://${profile.migrator}:${replace(urlencode(try(var.runtime_secret_values["greenguard-rds-bootstrap"]["${upper(owner)}_MIGRATOR_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/${profile.database}?sslmode=verify-full&sslrootcert=/rds-ca/ca.pem"
    } if profile.central },
    merge([for shard_id, shard in aws_db_instance.shard : {
      for owner, profile in local.migration_owner_contract : "greenguard-${shard_id}-${owner}-migration" => {
        (profile.key) = "postgresql://${profile.migrator}:${replace(urlencode(try(var.shard_role_passwords[shard_id]["${upper(owner)}_MIGRATOR_PASSWORD"], "")), "+", "%20")}@${shard.address}:5432/${profile.database}?sslmode=verify-full&sslrootcert=/rds-ca/ca.pem"
      } if !profile.central
    }]...)
  ) : {}
  shard_registry_values = { for service, profile in local.shard_service_profiles : service => {
    "registry.json" = jsonencode({ formatVersion = 1, service = service, database = profile.database, shards = {
      for shard_id, shard in aws_db_instance.shard : shard_id => {
        incarnation = local.shard_incarnations[shard_id]
        primaryUrl  = "postgresql://${profile.role}:${replace(urlencode(try(var.shard_registry_passwords[service][shard_id], "")), "+", "%20")}@${shard.address}:5432/${profile.database}?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem"
        replicaUrls = [for replica_id, replica in aws_db_instance.read_replica : "postgresql://${profile.role}:${replace(urlencode(try(var.shard_registry_passwords[service][shard_id], "")), "+", "%20")}@${replica.address}:5432/${profile.database}?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem" if local.postgres_shard_replicas[replica_id].shard_id == shard_id]
      }
    } })
  } }
  shard_registry_secret_versions  = { for service, version in aws_secretsmanager_secret_version.shard_routing : "greenguard-shard-routing-${service}" => version.version_id }
  shard_registry_secret_sources   = { for service, secret in aws_secretsmanager_secret.shard_routing : "greenguard-shard-routing-${service}" => secret.name if var.enable_application_tree }
  shard_bootstrap_secret_versions = { for shard_id, version in aws_secretsmanager_secret_version.shard_bootstrap : "greenguard-${shard_id}-rds-bootstrap" => version.version_id }
  shard_bootstrap_secret_sources  = { for shard_id in local.postgres_shard_ids : "greenguard-${shard_id}-rds-bootstrap" => aws_secretsmanager_secret.shard["${shard_id}/bootstrap"].name if var.enable_application_tree }
  shard_bootstrap_scope = { for shard_id, shard in aws_db_instance.shard : "greenguard-${shard_id}-rds-bootstrap" => {
    instance       = shard.identifier, host = shard.address, master_arn = shard.master_user_secret[0].secret_arn,
    master_version = try(data.aws_secretsmanager_secret_version.shard_master[shard_id].version_id, "")
    incarnation    = local.shard_incarnations[shard_id]
    replica_hosts  = [for replica_id, replica in aws_db_instance.read_replica : replica.address if local.postgres_shard_replicas[replica_id].shard_id == shard_id]
  } if var.enable_application_tree }
}

resource "aws_secretsmanager_secret_version" "shard_routing" {
  for_each      = var.enable_application_tree ? local.shard_service_profiles : {}
  secret_id     = aws_secretsmanager_secret.shard_routing[each.key].id
  secret_string = jsonencode(local.shard_registry_values[each.key])
  lifecycle {
    precondition {
      condition     = nonsensitive(toset(keys(var.shard_registry_passwords))) == toset(keys(local.shard_service_profiles)) && alltrue([for service, profile in local.shard_service_profiles : try(toset(keys(var.shard_registry_passwords[service])) == local.postgres_shard_ids && alltrue([for shard_id in local.postgres_shard_ids : var.shard_registry_passwords[service][shard_id] != "" && var.shard_registry_passwords[service][shard_id] == var.shard_role_passwords[shard_id][profile.password_key]]), false)])
      error_message = "Exactly ten complete s1-s4 registry credential maps must match the approved bootstrap service role passwords."
    }
    precondition {
      condition     = alltrue([for shard in values(aws_db_instance.shard) : length(shard.resource_id) > 0])
      error_message = "Immutable RDS resource identity is required for shard incarnation."
    }
  }
}

resource "aws_secretsmanager_secret_version" "shard_bootstrap" {
  for_each      = var.enable_application_tree ? local.postgres_shard_ids : toset([])
  secret_id     = aws_secretsmanager_secret.shard["${each.key}/bootstrap"].id
  secret_string = jsonencode(var.shard_role_passwords[each.key])
  lifecycle {
    precondition {
      condition     = nonsensitive(toset(keys(var.shard_role_passwords))) == local.postgres_shard_ids && alltrue([for passwords in values(var.shard_role_passwords) : toset(keys(passwords)) == local.runtime_bootstrap_role_keys])
      error_message = "Each shard must supply the exact complete bootstrap role profile."
    }
  }
}

data "aws_secretsmanager_secret_version" "shard_master" {
  for_each      = var.enable_application_tree ? local.postgres_shard_ids : toset([])
  secret_id     = aws_db_instance.shard[each.key].master_user_secret[0].secret_arn
  version_stage = "AWSCURRENT"
}

locals {
  shard_pgbouncer_roles = merge(
    { for service, profile in local.shard_service_profiles : profile.role => profile.password_key... },
    { inventory_projector = ["INVENTORY_PROJECTOR_PASSWORD"], telemetry_entitlement_projector = ["TELEMETRY_ENTITLEMENT_PROJECTOR_PASSWORD"], read_entitlement_projector = ["READ_ENTITLEMENT_PROJECTOR_PASSWORD"] }
  )
  shard_data_secret_values = merge([for shard_id in local.postgres_shard_ids : {
    "${shard_id}/pgbouncer" = { "userlist.txt" = join("\n", [for role, password_keys in local.shard_pgbouncer_roles : format("\"%s\" \"%s\"", role, try(var.shard_role_passwords[shard_id][password_keys[0]], ""))]) }
    "${shard_id}/cdc"       = { CDC_DB_PASSWORD = try(var.shard_role_passwords[shard_id]["CDC_DB_PASSWORD"], "") }
  }]...)
  shard_data_secret_versions = { for key, version in aws_secretsmanager_secret_version.shard_data : "greenguard-${split("/", key)[0]}-${split("/", key)[1] == "cdc" ? "cdc-credentials" : "pgbouncer-auth"}" => version.version_id }
  shard_data_secret_sources  = { for key in nonsensitive(keys(local.shard_data_secret_values)) : "greenguard-${split("/", key)[0]}-${split("/", key)[1] == "cdc" ? "cdc-credentials" : "pgbouncer-auth"}" => aws_secretsmanager_secret.shard[key].name if var.enable_application_tree }
}

resource "aws_secretsmanager_secret_version" "shard_data" {
  for_each      = var.enable_application_tree ? nonsensitive(toset(keys(local.shard_data_secret_values))) : toset([])
  secret_id     = aws_secretsmanager_secret.shard[each.key].id
  secret_string = jsonencode(local.shard_data_secret_values[each.key])
  lifecycle {
    precondition {
      condition     = alltrue([for role, password_keys in local.shard_pgbouncer_roles : try(length(var.shard_role_passwords[split("/", each.key)[0]][password_keys[0]]) > 0 && !can(regex("[\"\\\\\r\n]", var.shard_role_passwords[split("/", each.key)[0]][password_keys[0]])), false)])
      error_message = "PgBouncer role passwords must be nonempty and exclude quotes, backslashes and line breaks."
    }
  }
}

locals {
  projector_registry_profiles = {
    read-entitlement-projector      = { service = "read-api", role = "read_entitlement_projector", database = "greenguard_read", password_key = "READ_ENTITLEMENT_PROJECTOR_PASSWORD" }
    inventory-projector             = { service = "device-service", role = "inventory_projector", database = "greenguard_inventory", password_key = "INVENTORY_PROJECTOR_PASSWORD" }
    telemetry-entitlement-projector = { service = "telemetry-ingest", role = "telemetry_entitlement_projector", database = "greenguard_telemetry", password_key = "TELEMETRY_ENTITLEMENT_PROJECTOR_PASSWORD" }
  }
  projector_registry_values = { for name, profile in local.projector_registry_profiles : name => {
    "registry.json" = jsonencode({ formatVersion = 1, service = profile.service, database = profile.database, shards = {
      for shard_id, shard in aws_db_instance.shard : shard_id => {
        incarnation = local.shard_incarnations[shard_id]
        primaryUrl  = "postgresql://${profile.role}:${replace(urlencode(try(var.shard_role_passwords[shard_id][profile.password_key], "")), "+", "%20")}@${shard.address}:5432/${profile.database}?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem"
        replicaUrls = [for replica_id, replica in aws_db_instance.read_replica : "postgresql://${profile.role}:${replace(urlencode(try(var.shard_role_passwords[shard_id][profile.password_key], "")), "+", "%20")}@${replica.address}:5432/${profile.database}?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem" if local.postgres_shard_replicas[replica_id].shard_id == shard_id]
      }
    } })
  } }
  projector_registry_secret_versions = { for name, version in aws_secretsmanager_secret_version.projector_routing : "greenguard-shard-routing-${name}" => version.version_id }
  projector_registry_secret_sources  = { for name, secret in aws_secretsmanager_secret.projector_routing : "greenguard-shard-routing-${name}" => secret.name }
}

resource "aws_secretsmanager_secret" "projector_routing" {
  for_each                = var.enable_application_tree ? local.projector_registry_profiles : {}
  name                    = "greenguard/${var.environment}/shard-routing/${each.key}"
  recovery_window_in_days = 0
  tags                    = { Cell = var.cluster_name, Service = each.value.service, Role = each.value.role }
}

resource "aws_secretsmanager_secret_version" "projector_routing" {
  for_each      = var.enable_application_tree ? local.projector_registry_profiles : {}
  secret_id     = aws_secretsmanager_secret.projector_routing[each.key].id
  secret_string = jsonencode(local.projector_registry_values[each.key])
  lifecycle {
    precondition {
      condition     = alltrue([for shard_id in local.postgres_shard_ids : try(length(var.shard_role_passwords[shard_id][each.value.password_key]) > 0, false)])
      error_message = "Projector registries require every shard's exact approved projector role password."
    }
  }
}
