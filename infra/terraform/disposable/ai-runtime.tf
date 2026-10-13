# Isolated AI database credential ownership. This does not enable AI Argo
# Applications or copy Secrets Manager values into Kubernetes; that wiring must
# be added to the audited runtime-secret lifecycle before `ai_runtime_enabled`
# is allowed for a real deployment.
variable "ai_runtime_enabled" {
  description = "Create disposable AI data services, source storage, roles, identities and runtime Secrets. AI Argo remains gated on migration/dependency acceptance."
  type        = bool
  default     = false
  validation {
    condition     = !var.ai_runtime_enabled || (var.ai_runtime_sources_complete && toset(keys(var.ai_runtime_image_digests)) == toset(["knowledge", "indexer", "parser", "advisor", "gateway", "usage", "mcp", "clamav"]))
    error_message = "AI runtime enablement requires a complete checked-in source release and all eight immutable AI image digests; missing service sources must remain disabled."
  }
}

variable "ai_database_role_passwords" {
  description = "Ephemeral independent passwords for AI database runtime, API and worker, schema-owner and provisioning roles."
  type        = map(string)
  sensitive   = true
  ephemeral   = true
  default     = {}
  validation {
    condition = length(var.ai_database_role_passwords) == 0 || (
      toset(keys(var.ai_database_role_passwords)) == toset([
        "KNOWLEDGE_APP_PASSWORD", "KNOWLEDGE_MIGRATOR_PASSWORD",
        "KNOWLEDGE_PROVISIONER_PASSWORD", "KNOWLEDGE_REVIEWER_PASSWORD", "KNOWLEDGE_WORKER_PASSWORD",
        "ADVISOR_APP_PASSWORD", "ADVISOR_MIGRATOR_PASSWORD",
        "ADVISOR_CHECKPOINT_APP_PASSWORD", "ADVISOR_CHECKPOINT_MIGRATOR_PASSWORD",
        "MODEL_GATEWAY_APP_PASSWORD", "MODEL_GATEWAY_USAGE_PASSWORD",
        "MODEL_GATEWAY_MIGRATOR_PASSWORD",
      ]) && alltrue([for value in values(var.ai_database_role_passwords) : length(value) >= 32]) && length(toset(values(var.ai_database_role_passwords))) == 12
    )
    error_message = "AI database credentials must contain exactly twelve independently generated passwords, each at least 32 characters."
  }
}

variable "ai_database_secret_version" {
  description = "Public write-only version counter for the disposable AI role-secret payload. Increment when rotating any AI role password."
  type        = number
  default     = 1
  validation {
    condition     = var.ai_database_secret_version >= 1 && var.ai_database_secret_version == floor(var.ai_database_secret_version)
    error_message = "ai_database_secret_version must be a positive integer."
  }
}

variable "ai_delegated_signing_material" {
  description = "Ephemeral BFF delegated-token signing material generated for this disposable cell. The private RSA key is written only to a write-only Secrets Manager version and never Terraform state."
  type        = map(string)
  sensitive   = true
  ephemeral   = true
  default     = {}
  validation {
    condition = length(var.ai_delegated_signing_material) == 0 || (
      toset(keys(var.ai_delegated_signing_material)) == toset(["BFF_DELEGATED_PRIVATE_KEY_PEM", "BFF_DELEGATED_KID"]) &&
      can(regex("^-----BEGIN PRIVATE KEY-----[\\s\\S]+-----END PRIVATE KEY-----\\s*$", try(var.ai_delegated_signing_material["BFF_DELEGATED_PRIVATE_KEY_PEM"], ""))) &&
      can(regex("^[A-Za-z0-9._-]{1,64}$", try(var.ai_delegated_signing_material["BFF_DELEGATED_KID"], "")))
    )
    error_message = "AI delegated signing material must contain an RSA PKCS#8 private key and a safe key identifier."
  }
}

locals {
  ai_database_names = toset([
    "greenguard_knowledge", "greenguard_advisor",
    "greenguard_advisor_checkpoint", "greenguard_ai_usage",
  ])
  ai_database_secret_name = "greenguard/${var.environment}/cell-${substr(sha256(var.cluster_name), 0, 16)}/ai/database-roles"
  # The delegation issuer is distinct from the real user's Dex/OIDC issuer.
  # BFF publishes this public key on the same HTTPS API hostname.
  ai_delegated_issuer   = "https://${aws_cloudfront_distribution.api.domain_name}/delegated"
  ai_delegated_jwks_url = "https://${aws_cloudfront_distribution.api.domain_name}/.well-known/delegated-jwks.json"
}

resource "aws_secretsmanager_secret" "ai_database_roles" {
  count                   = var.ai_runtime_enabled ? 1 : 0
  depends_on              = [terraform_data.destroy_inventory_sentinel]
  name                    = local.ai_database_secret_name
  recovery_window_in_days = 0
  tags = {
    Environment = var.environment
    Cell        = var.cluster_name
    CellId      = substr(sha256(var.cluster_name), 0, 16)
    Lifecycle   = "Disposable"
    ManagedBy   = "Terraform"
    SecretOwner = "greenguard-ai-runtime"
  }
  lifecycle {
    precondition {
      condition     = !contains(["prod", "production"], lower(var.environment))
      error_message = "AI runtime database secrets are restricted to a disposable non-production cell."
    }
    precondition {
      condition     = toset(keys(var.ai_database_role_passwords)) == toset(["KNOWLEDGE_APP_PASSWORD", "KNOWLEDGE_WORKER_PASSWORD", "KNOWLEDGE_MIGRATOR_PASSWORD", "KNOWLEDGE_PROVISIONER_PASSWORD", "KNOWLEDGE_REVIEWER_PASSWORD", "ADVISOR_APP_PASSWORD", "ADVISOR_MIGRATOR_PASSWORD", "ADVISOR_CHECKPOINT_APP_PASSWORD", "ADVISOR_CHECKPOINT_MIGRATOR_PASSWORD", "MODEL_GATEWAY_APP_PASSWORD", "MODEL_GATEWAY_USAGE_PASSWORD", "MODEL_GATEWAY_MIGRATOR_PASSWORD"]) && alltrue([for value in values(var.ai_database_role_passwords) : length(value) >= 32]) && length(toset(values(var.ai_database_role_passwords))) == 12
      error_message = "Enabling AI database ownership requires twelve distinct, independently generated role credentials of at least 32 characters."
    }
  }
}

resource "aws_secretsmanager_secret_version" "ai_database_roles" {
  count                    = var.ai_runtime_enabled ? 1 : 0
  depends_on               = [terraform_data.destroy_inventory_sentinel, terraform_data.ai_bundle_guard]
  secret_id                = aws_secretsmanager_secret.ai_database_roles[0].id
  secret_string_wo         = jsonencode(var.ai_database_role_passwords)
  secret_string_wo_version = var.ai_database_secret_version
}

output "ai_database_secret_arn" {
  description = "Disposable AI database role-secret ARN; output contains no payload."
  value       = try(aws_secretsmanager_secret.ai_database_roles[0].arn, null)
}
