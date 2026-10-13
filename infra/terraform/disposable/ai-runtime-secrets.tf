# AI runtime secret payloads are ephemeral at plan/apply time and write-only in
# Secrets Manager. Values are encoded into the provider's write-only SecretString
# map; lifecycle input stores only exact AWS names/version IDs and cell scope.
variable "ai_runtime_secret_material" {
  description = "Ephemeral provider, Kafka, AI Redis TLS and tenant-namespace key material. Required only for the opt-in disposable AI runtime."
  type        = map(string)
  sensitive   = true
  ephemeral   = true
  default     = {}
  validation {
    condition = length(var.ai_runtime_secret_material) == 0 || toset(keys(var.ai_runtime_secret_material)) == toset([
      "KNOWLEDGE_NAMESPACE_HMAC_KEY", "PINECONE_API_KEY", "AI_REDIS_PASSWORD",
      "AI_REDIS_SERVER_CERT_PEM", "AI_REDIS_SERVER_KEY_PEM", "AI_REDIS_CA_PEM",
      "VOYAGE_API_KEY", "ANTHROPIC_API_KEY", "AI_KAFKA_KNOWLEDGE_PASSWORD",
      "AI_KAFKA_USAGE_PASSWORD", "ADVISOR_ALERTS_SERVICE_TOKEN",
    ])
    error_message = "AI runtime requires the exact provider, TLS Redis, Kafka and Advisor token secret contract."
  }
  validation {
    condition     = alltrue([for key, value in var.ai_runtime_secret_material : length(value) > 0 && length(value) <= 12000])
    error_message = "Each AI credential or PEM field must be nonempty and at most 12000 characters; full bundles are never passed to process environments."
  }
}

variable "ai_gateway_tenant_tokens" {
  description = "Ephemeral per-tenant opaque Gateway credentials shared with the BFF token projection. Keys are canonical tenant UUIDs; never map users implicitly."
  type        = map(string)
  sensitive   = true
  ephemeral   = true
  default     = {}
  validation {
    condition = length(var.ai_gateway_tenant_tokens) == 0 || (
      length(var.ai_gateway_tenant_tokens) <= 100 &&
      alltrue([for tenant, token in var.ai_gateway_tenant_tokens : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", tenant)) && length(token) >= 32 && length(token) <= 16384 && !can(regex("[[:space:]]", token))])
    )
    error_message = "Gateway tokens require 1-100 canonical tenant UUIDs and independent opaque tokens (32-16384 bytes)."
  }
}

variable "ai_conversation_retention_scopes" {
  description = "Explicit tenant/user UUID scopes authorized for conversation retention. No inferred or wildcard users."
  type = list(object({
    tenant_id = string
    user_id   = string
  }))
  default = []
  validation {
    condition = (length(var.ai_conversation_retention_scopes) <= 5000 &&
      length(distinct([for scope in var.ai_conversation_retention_scopes : "${scope.tenant_id}:${scope.user_id}"])) == length(var.ai_conversation_retention_scopes) &&
    alltrue([for scope in var.ai_conversation_retention_scopes : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", scope.tenant_id)) && can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", scope.user_id))]))
    error_message = "Conversation retention requires unique canonical tenant/user UUID pairs."
  }
}

variable "ai_model_gateway_budget_caps" {
  description = "Ephemeral, explicit UTC-month platform/tenant/user AI budget caps. Caller must supply verified tenant and principal UUIDs; no defaults or inferred users are provisioned."
  type = object({
    platform = object({ limit_micros = number, limit_tokens = number })
    tenants = list(object({
      tenant_id = string
      limit     = object({ limit_micros = number, limit_tokens = number })
      users = optional(list(object({
        principal_id = string
        limit        = object({ limit_micros = number, limit_tokens = number })
      })), [])
    }))
  })
  sensitive = true
  ephemeral = true
  default   = null
  validation {
    condition = var.ai_model_gateway_budget_caps == null ? true : (
      length(var.ai_model_gateway_budget_caps.tenants) >= 1 &&
      length(var.ai_model_gateway_budget_caps.tenants) <= 5000 &&
      length(distinct([for tenant in var.ai_model_gateway_budget_caps.tenants : tenant.tenant_id])) == length(var.ai_model_gateway_budget_caps.tenants) &&
      sum([for tenant in var.ai_model_gateway_budget_caps.tenants : length(tenant.users)]) <= 25000 &&
      length(distinct(flatten([for tenant in var.ai_model_gateway_budget_caps.tenants : [for user in tenant.users : "${tenant.tenant_id}:${user.principal_id}"]]))) == sum([for tenant in var.ai_model_gateway_budget_caps.tenants : length(tenant.users)]) &&
      alltrue([for tenant in var.ai_model_gateway_budget_caps.tenants : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", tenant.tenant_id)) && alltrue([for id in concat([tenant.limit.limit_micros, tenant.limit.limit_tokens], flatten([for user in tenant.users : [user.limit.limit_micros, user.limit.limit_tokens]])) : id >= 0 && id <= 1000000000000000 && id == floor(id)]) && alltrue([for user in tenant.users : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", user.principal_id))])]) &&
    alltrue([for cap in [var.ai_model_gateway_budget_caps.platform.limit_micros, var.ai_model_gateway_budget_caps.platform.limit_tokens] : cap >= 0 && cap <= 1000000000000000 && cap == floor(cap)]))
    error_message = "AI budgets require 1-5000 unique canonical tenants, bounded integer caps, and at most 25000 unique canonical tenant/principal pairs."
  }
}

variable "ai_pinecone_index_host" {
  description = "Existing Pinecone index HTTPS host for this GreenGuard runtime."
  type        = string
  default     = ""
}

variable "ai_clamav_host" {
  description = "Private in-cluster ClamAV service host used by Knowledge PDF ingestion."
  type        = string
  default     = ""
}

variable "ai_runtime_secret_version" {
  description = "Public write-only version counter for the immutable AI runtime secret bundle. Existing bundle changes are rejected; rotate by destroying and recreating the disposable cell."
  type        = number
  default     = 1
  validation {
    condition     = var.ai_runtime_secret_version == 1
    error_message = "AI runtime secret rotation is not supported in-place; retain version 1 and recreate the disposable cell to rotate credentials."
  }
}

locals {
  ai_cell_hash = substr(sha256(var.cluster_name), 0, 16)
  ai_secret_targets = toset([
    "greenguard-ai-database-roles",
    "greenguard-knowledge-runtime",
    "greenguard-knowledge-worker-runtime",
    "greenguard-knowledge-migrator",
    "greenguard-advisor-runtime",
    "greenguard-advisor-migrator",
    "greenguard-model-gateway-runtime",
    "greenguard-model-gateway-migrator",
    "greenguard-model-gateway-budget-bootstrap",
    "greenguard-model-gateway-usage",
    "greenguard-ai-kafka-ca",
    "greenguard-ai-redis",
    "greenguard-bff-model-gateway",
    "greenguard-bff-delegation",
  ])
  ai_secret_sources = {
    for target in local.ai_secret_targets : target => target == "greenguard-ai-database-roles"
    ? local.ai_database_secret_name
    : "greenguard/${var.environment}/cell-${local.ai_cell_hash}/ai/runtime/${target}"
  }
  ai_db_url = {
    knowledge_app      = "postgresql://knowledge_app:${replace(urlencode(try(var.ai_database_role_passwords["KNOWLEDGE_APP_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_knowledge?sslmode=verify-full&sslrootcert=/rds-ca/ca.pem&connect_timeout=10"
    knowledge_worker   = "postgresql://knowledge_worker:${replace(urlencode(try(var.ai_database_role_passwords["KNOWLEDGE_WORKER_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_knowledge?sslmode=verify-full&sslrootcert=/rds-ca/ca.pem&connect_timeout=10"
    knowledge_migrator = "postgresql://knowledge_migrator:${replace(urlencode(try(var.ai_database_role_passwords["KNOWLEDGE_MIGRATOR_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_knowledge?sslmode=verify-full&sslrootcert=/rds-ca/ca.pem&connect_timeout=10"
    advisor_app        = "postgresql://advisor_app:${replace(urlencode(try(var.ai_database_role_passwords["ADVISOR_APP_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_advisor?sslmode=verify-full&sslrootcert=/rds-ca/ca.pem&connect_timeout=10"
    advisor_migrator   = "postgresql://advisor_migrator:${replace(urlencode(try(var.ai_database_role_passwords["ADVISOR_MIGRATOR_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_advisor?sslmode=verify-full&sslrootcert=/rds-ca/ca.pem&connect_timeout=10"
    gateway_app        = "postgresql://model_gateway_app:${replace(urlencode(try(var.ai_database_role_passwords["MODEL_GATEWAY_APP_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_ai_usage?sslmode=verify-full&sslrootcert=/rds-ca/ca.pem&connect_timeout=10"
    gateway_usage      = "postgresql://model_gateway_usage_app:${replace(urlencode(try(var.ai_database_role_passwords["MODEL_GATEWAY_USAGE_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_ai_usage?sslmode=verify-full&sslrootcert=/rds-ca/ca.pem&connect_timeout=10"
    gateway_migrator   = "postgresql://model_gateway_migrator:${replace(urlencode(try(var.ai_database_role_passwords["MODEL_GATEWAY_MIGRATOR_PASSWORD"], "")), "+", "%20")}@${aws_db_instance.postgres.address}:5432/greenguard_ai_usage?sslmode=verify-full&sslrootcert=/rds-ca/ca.pem&connect_timeout=10"
  }
  ai_gateway_token_file = jsonencode(var.ai_gateway_tenant_tokens)
  ai_gateway_access_file = jsonencode({
    token_hashes = {
      for tenant_id, token in var.ai_gateway_tenant_tokens : sha256(token) => {
        tenant_id            = tenant_id
        scopes               = ["knowledge:embed", "knowledge:rerank", "knowledge:answer"]
        trusted_user_context = true
      }
    }
    embedding_models = { "embed-v1" = var.ai_provider_models.embedding }
    reranker_models  = { "rerank-v1" = var.ai_provider_models.reranker }
    answer_models    = { "answer-v1" = var.ai_provider_models.answer }
  })
  ai_controls_example = jsondecode(file("${path.module}/../../../services/model-gateway/controls.example.json"))
  ai_gateway_controls_file = jsonencode(merge(local.ai_controls_example, {
    prices = {
      (var.ai_provider_models.embedding) = local.ai_controls_example.prices["voyage-4-large"]
      (var.ai_provider_models.reranker)  = local.ai_controls_example.prices["rerank-2.5"]
      (var.ai_provider_models.answer)    = local.ai_controls_example.prices["claude-haiku-4-5-20251001"]
    }
  }))
  ai_redis_url            = "rediss://:${replace(urlencode(try(var.ai_runtime_secret_material["AI_REDIS_PASSWORD"], "")), "+", "%20")}@ai-redis.greenguard.svc.cluster.local:6379/0"
  ai_kafka_brokers        = "kafka.greenguard.svc.cluster.local:29092"
  ai_control_lookup_token = try(var.runtime_secret_values["tenant-control-plane-config"]["CONTROL_LOOKUP_TOKEN"], "")
  ai_kafka_jaas           = try(var.runtime_secret_values["greenguard-kafka-auth"]["broker-jaas"], "")
  ai_kafka_users_are_provisioned = (
    strcontains(local.ai_kafka_jaas, "user_knowledge-service=\"${try(var.ai_runtime_secret_material["AI_KAFKA_KNOWLEDGE_PASSWORD"], "")}\"") &&
    strcontains(local.ai_kafka_jaas, "user_model-gateway-usage=\"${try(var.ai_runtime_secret_material["AI_KAFKA_USAGE_PASSWORD"], "")}\"")
  )
  ai_usage_kafka_config = {
    "bootstrap.servers"  = local.ai_kafka_brokers
    "security.protocol"  = "SASL_SSL"
    "sasl.mechanism"     = "PLAIN"
    "sasl.username"      = "model-gateway-usage"
    "sasl.password"      = try(var.ai_runtime_secret_material["AI_KAFKA_USAGE_PASSWORD"], "")
    "ssl.ca.location"    = "/kafka-ca/ca.pem"
    "enable.idempotence" = true
    "acks"               = "all"
  }
  ai_runtime_payloads = {
    "greenguard-ai-database-roles" = { for key, value in var.ai_database_role_passwords : key => base64encode(value) }
    "greenguard-knowledge-runtime" = {
      "database-url"          = base64encode(local.ai_db_url.knowledge_app)
      "control-lookup-token"  = base64encode(local.ai_control_lookup_token)
      "namespace-hmac-key"    = base64encode(try(var.ai_runtime_secret_material["KNOWLEDGE_NAMESPACE_HMAC_KEY"], ""))
      "pinecone-api-key"      = base64encode(try(var.ai_runtime_secret_material["PINECONE_API_KEY"], ""))
      "redis-url"             = base64encode(local.ai_redis_url)
      "gateway-tokens.json"   = base64encode(local.ai_gateway_token_file)
      "relay-tenants.json"    = base64encode(jsonencode(keys(var.ai_gateway_tenant_tokens)))
      "retention-scopes.json" = base64encode(jsonencode(var.ai_conversation_retention_scopes))
      "kafka-username"        = base64encode("knowledge-service")
      "kafka-password"        = base64encode(try(var.ai_runtime_secret_material["AI_KAFKA_KNOWLEDGE_PASSWORD"], ""))
    }
    "greenguard-knowledge-worker-runtime" = {
      "database-url" = base64encode(local.ai_db_url.knowledge_worker)
    }
    "greenguard-knowledge-migrator" = { "database-url" = base64encode(local.ai_db_url.knowledge_migrator) }
    "greenguard-advisor-runtime" = {
      "database-url"             = base64encode(local.ai_db_url.advisor_app)
      "membership-service-token" = base64encode(local.ai_control_lookup_token)
      "alerts-service-token"     = base64encode(try(var.ai_runtime_secret_material["ADVISOR_ALERTS_SERVICE_TOKEN"], ""))
    }
    "greenguard-advisor-migrator" = { "database-url" = base64encode(local.ai_db_url.advisor_migrator) }
    "greenguard-model-gateway-runtime" = {
      "access.json"   = base64encode(local.ai_gateway_access_file)
      "controls.json" = base64encode(local.ai_gateway_controls_file)
      "redis-url"     = base64encode(local.ai_redis_url)
      "budget-dsn"    = base64encode(local.ai_db_url.gateway_app)
      "voyage-key"    = base64encode(try(var.ai_runtime_secret_material["VOYAGE_API_KEY"], ""))
      "anthropic-key" = base64encode(try(var.ai_runtime_secret_material["ANTHROPIC_API_KEY"], ""))
    }
    "greenguard-model-gateway-migrator" = { "database-url" = base64encode(local.ai_db_url.gateway_migrator) }
    "greenguard-model-gateway-budget-bootstrap" = {
      "budget-dsn"       = base64encode(local.ai_db_url.gateway_migrator)
      "budget-caps.json" = base64encode(jsonencode(var.ai_model_gateway_budget_caps))
    }
    "greenguard-model-gateway-usage" = {
      "relay.json" = base64encode(jsonencode({
        database_url = local.ai_db_url.gateway_usage
        tenant_ids   = keys(var.ai_gateway_tenant_tokens)
        kafka        = local.ai_usage_kafka_config
      }))
      "consume.json" = base64encode(jsonencode({
        database_url = local.ai_db_url.gateway_usage
        tenant_ids   = keys(var.ai_gateway_tenant_tokens)
        group_id     = "greenguard-model-gateway-usage-v1"
        kafka        = local.ai_usage_kafka_config
      }))
    }
    "greenguard-ai-kafka-ca" = {
      "ca.pem" = base64encode(try(var.runtime_secret_values["greenguard-kafka-ca"]["ca.crt"], ""))
    }
    "greenguard-ai-redis" = {
      "password"   = base64encode(try(var.ai_runtime_secret_material["AI_REDIS_PASSWORD"], ""))
      "server.crt" = base64encode(try(var.ai_runtime_secret_material["AI_REDIS_SERVER_CERT_PEM"], ""))
      "server.key" = base64encode(try(var.ai_runtime_secret_material["AI_REDIS_SERVER_KEY_PEM"], ""))
      "ca.pem"     = base64encode(try(var.ai_runtime_secret_material["AI_REDIS_CA_PEM"], ""))
    }
    "greenguard-bff-model-gateway" = {
      "gateway-tokens.json" = base64encode(local.ai_gateway_token_file)
    }
    "greenguard-bff-delegation" = {
      "private-key.pem" = base64encode(try(var.ai_delegated_signing_material["BFF_DELEGATED_PRIVATE_KEY_PEM"], ""))
      "kid"             = base64encode(try(var.ai_delegated_signing_material["BFF_DELEGATED_KID"], ""))
    }
  }
  ai_secret_scope = {
    account_id  = var.target_account_id
    region      = var.aws_region
    environment = var.environment
    cell        = var.cluster_name
    cluster     = var.cluster_name
    namespace   = "greenguard"
    sources     = local.ai_secret_sources
    versions = merge(
      { for name, version in aws_secretsmanager_secret_version.ai_runtime : name => version.version_id },
      var.ai_runtime_enabled ? { "greenguard-ai-database-roles" = aws_secretsmanager_secret_version.ai_database_roles[0].version_id } : {},
    )
  }
}

resource "aws_secretsmanager_secret" "ai_runtime" {
  for_each                = var.ai_runtime_enabled ? setsubtract(local.ai_secret_targets, toset(["greenguard-ai-database-roles"])) : toset([])
  depends_on              = [terraform_data.destroy_inventory_sentinel]
  name                    = local.ai_secret_sources[each.key]
  recovery_window_in_days = 0
  tags = {
    Environment = var.environment
    Cell        = var.cluster_name
    CellId      = local.ai_cell_hash
    Lifecycle   = "Disposable"
    ManagedBy   = "Terraform"
    SecretOwner = "greenguard-ai-runtime"
  }

  lifecycle {
    precondition {
      condition = !var.ai_runtime_enabled || (
        lower(var.environment) == "disposable" && var.enable_application_tree &&
        toset(keys(var.ai_runtime_secret_material)) == toset([
          "KNOWLEDGE_NAMESPACE_HMAC_KEY", "PINECONE_API_KEY", "AI_REDIS_PASSWORD",
          "AI_REDIS_SERVER_CERT_PEM", "AI_REDIS_SERVER_KEY_PEM", "AI_REDIS_CA_PEM",
          "VOYAGE_API_KEY", "ANTHROPIC_API_KEY", "AI_KAFKA_KNOWLEDGE_PASSWORD",
          "AI_KAFKA_USAGE_PASSWORD", "ADVISOR_ALERTS_SERVICE_TOKEN",
        ]) && alltrue([for value in values(var.ai_runtime_secret_material) : length(value) > 0]) &&
        can(regex("^[0-9a-f]{64,}$", try(var.ai_runtime_secret_material["KNOWLEDGE_NAMESPACE_HMAC_KEY"], ""))) &&
        can(regex("^[A-Za-z0-9_-]{32,128}$", try(var.ai_runtime_secret_material["AI_REDIS_PASSWORD"], ""))) &&
        length(try(var.ai_runtime_secret_material["AI_KAFKA_KNOWLEDGE_PASSWORD"], "")) >= 24 &&
        length(try(var.ai_runtime_secret_material["AI_KAFKA_USAGE_PASSWORD"], "")) >= 24 &&
        length(try(var.ai_runtime_secret_material["ADVISOR_ALERTS_SERVICE_TOKEN"], "")) >= 32 &&
        length(var.ai_gateway_tenant_tokens) > 0 && length(var.ai_conversation_retention_scopes) > 0 &&
        alltrue([for scope in var.ai_conversation_retention_scopes : contains(keys(var.ai_gateway_tenant_tokens), scope.tenant_id)]) &&
        length(var.ai_database_role_passwords) == 12 &&
        var.ai_model_gateway_budget_caps != null &&
        toset([for tenant in var.ai_model_gateway_budget_caps.tenants : tenant.tenant_id]) == toset(keys(var.ai_gateway_tenant_tokens)) &&
        length(try(var.runtime_secret_values["tenant-control-plane-config"]["CONTROL_LOOKUP_TOKEN"], "")) >= 32 &&
        can(regex("^https://[A-Za-z0-9.-]+(:443)?(/[^[:space:]?#]*)?$", var.ai_pinecone_index_host)) &&
        can(regex("^https://[A-Za-z0-9.-]+(:443)?(/[^[:space:]?#]*)?$", local.ai_delegated_issuer)) &&
        can(regex("^https://[A-Za-z0-9.-]+(:443)?(/[^[:space:]?#]*)?$", local.ai_delegated_jwks_url)) &&
        toset(keys(var.ai_delegated_signing_material)) == toset(["BFF_DELEGATED_PRIVATE_KEY_PEM", "BFF_DELEGATED_KID"]) &&
        length(try(var.ai_delegated_signing_material["BFF_DELEGATED_PRIVATE_KEY_PEM"], "")) >= 200 &&
        can(regex("^[A-Za-z0-9._-]{3,64}$", try(var.ai_delegated_signing_material["BFF_DELEGATED_KID"], ""))) &&
        can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.ai_clamav_host)) &&
        local.ai_kafka_users_are_provisioned &&
        alltrue([for model in values(var.ai_provider_models) : length(trimspace(model)) > 0 && length(model) <= 256 && !can(regex("[[:space:]]", model))]) &&
        try(local.oidc_public.token_mode == "audience" ? length(local.oidc_public.audience) > 0 : (local.oidc_public.token_mode == "cognito-access" && length(local.oidc_public.mobile_client_id) > 0 && length(local.oidc_public.web_client_id) > 0), false) &&
        try(length(var.runtime_secret_values["greenguard-kafka-ca"]["ca.crt"]) > 0, false) &&
        local.oidc_public != null && try(length(local.oidc_public.issuer) > 0 && length(local.oidc_public.jwks_url) > 0, false)
      )
      error_message = "AI runtime opt-in requires the exact non-production cell, immutable external/provider inputs, verified OIDC, delegated signing, explicit tenant and retention scopes, existing control-plane/RDS/Kafka contracts, scoped AI broker users and the complete disposable application tree."
    }
  }
}

# Every plan/apply checks the full ephemeral payload against current exact-cell
# AWS versions before any AI or BFF secret version can be written. On first
# creation the entire bundle must be absent; partial existing bundles fail.
resource "terraform_data" "ai_bundle_guard" {
  count            = var.ai_runtime_enabled ? 1 : 0
  triggers_replace = { every_apply = timestamp() }
  input = {
    cell        = var.cluster_name
    environment = var.environment
    account_id  = var.target_account_id
  }
  depends_on = [
    terraform_data.destroy_inventory_sentinel,
    aws_secretsmanager_secret.ai_runtime,
    aws_secretsmanager_secret.ai_database_roles,
    aws_eks_cluster.cell,
  ]
  provisioner "local-exec" {
    interpreter = ["python3", "${path.module}/../../../infra/gitops/disposable/ai-secret-lifecycle.py"]
    command     = "guard"
    quiet       = true
    environment = {
      GG_AI_SCOPE = jsonencode({
        account_id  = var.target_account_id
        region      = var.aws_region
        environment = var.environment
        cell        = var.cluster_name
        cluster     = var.cluster_name
        namespace   = "greenguard"
        sources     = local.ai_secret_sources
      })
      # Fingerprints keep tenant-token and budget maps out of exec environments.
      GG_AI_EXPECTED_FINGERPRINTS = jsonencode({ for name, payload in local.ai_runtime_payloads : name => { for key, value in payload : key => sha256(value) } })
      GG_AI_REDIS_TLS             = jsonencode({ for key in ["server.crt", "server.key", "ca.pem"] : key => local.ai_runtime_payloads["greenguard-ai-redis"][key] })
    }
  }
}

resource "aws_secretsmanager_secret_version" "ai_runtime" {
  for_each                 = var.ai_runtime_enabled ? setsubtract(local.ai_secret_targets, toset(["greenguard-ai-database-roles"])) : toset([])
  depends_on               = [terraform_data.destroy_inventory_sentinel, terraform_data.ai_bundle_guard]
  secret_id                = aws_secretsmanager_secret.ai_runtime[each.key].id
  secret_string_wo         = jsonencode(local.ai_runtime_payloads[each.key])
  secret_string_wo_version = var.ai_runtime_secret_version
  lifecycle {
    precondition {
      # These maps contain ASCII base64 values, so character and byte lengths match.
      condition     = length(jsonencode(local.ai_runtime_payloads[each.key])) <= 65536
      error_message = "Encoded SecretString exceeds the AWS 65536-byte limit; split the configuration before provisioning."
    }
  }
}

resource "terraform_data" "ai_secret_sync" {
  count = var.ai_runtime_enabled ? 1 : 0
  triggers_replace = {
    versions = jsonencode(local.ai_secret_scope.versions)
  }
  input = {
    versions = local.ai_secret_scope.versions
  }
  depends_on = [
    terraform_data.destroy_inventory_sentinel,
    terraform_data.ai_bundle_guard,
    aws_secretsmanager_secret_version.ai_runtime,
    aws_secretsmanager_secret_version.ai_database_roles,
    aws_eks_cluster.cell,
    aws_eks_access_policy_association.cluster_admin,
    helm_release.greenguard_namespace,
    aws_eks_node_group.general,
    aws_eks_node_group.compute,
    aws_eks_addon.pod_identity_agent,
  ]
  provisioner "local-exec" {
    interpreter = ["python3", "${path.module}/../../../infra/gitops/disposable/ai-secret-lifecycle.py"]
    command     = "sync"
    quiet       = true
    environment = { GG_AI_SCOPE = jsonencode(local.ai_secret_scope) }
  }
}

resource "terraform_data" "ai_secret_cleanup" {
  count = var.ai_runtime_enabled ? 1 : 0
  input = local.ai_secret_scope
  depends_on = [
    terraform_data.destroy_inventory_sentinel,
    terraform_data.ai_secret_sync,
    aws_eks_cluster.cell,
    aws_eks_access_policy_association.cluster_admin,
    helm_release.greenguard_namespace,
    aws_eks_node_group.general,
    aws_eks_node_group.compute,
    aws_eks_addon.pod_identity_agent,
  ]
  provisioner "local-exec" {
    when        = destroy
    interpreter = ["python3", "${path.module}/../../../infra/gitops/disposable/ai-secret-lifecycle.py"]
    command     = "cleanup"
    quiet       = true
    environment = { GG_AI_SCOPE = jsonencode(self.input) }
  }
}

output "ai_runtime_secret_sync_ready" {
  description = "True only when the exact cell's AI Secret bundle has been synchronized into the greenguard namespace."
  value       = var.ai_runtime_enabled ? terraform_data.ai_secret_sync[0].id : null
}

output "ai_knowledge_s3_bucket" {
  description = "Terraform-owned source-documents bucket for the disposable AI runtime."
  value       = try(aws_s3_bucket.ai_knowledge_documents[0].id, null)
}
