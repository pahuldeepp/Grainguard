# Opt-in isolated synthetic scoring cell. The six Secrets Manager payloads are
# ephemeral Terraform inputs and use write-only SecretString fields; only
# source/version metadata enters Terraform state.
variable "ml_synthetic_enabled" {
  description = "Create the isolated synthetic-only ML scoring cell and its opt-in Argo Applications. Never enables product predictions."
  type        = bool
  default     = false
}

variable "ml_synthetic_scorer_image_digest" {
  description = "Full immutable digest reference for the CI-published synthetic scorer image, from the approved GHCR namespace or exact cell ECR repository."
  type        = string
  sensitive   = false
  default     = ""
  validation {
    condition = var.ml_synthetic_scorer_image_digest == "" || (
      can(regex("^ghcr\\.io/pahuldeepp/grainguard/ml-scoring-synthetic@sha256:[a-f0-9]{64}$", var.ml_synthetic_scorer_image_digest)) ||
      can(regex("^${var.target_account_id}\\.dkr\\.ecr\\.${var.aws_region}\\.amazonaws\\.com/greenguard/${var.environment}/cell-${substr(sha256(var.cluster_name), 0, 16)}/ml-scoring-synthetic@sha256:[a-f0-9]{64}$", var.ml_synthetic_scorer_image_digest))
    )
    error_message = "ml_synthetic_scorer_image_digest must be a digest-pinned image from the approved GHCR namespace or this exact AWS account/region/cell ECR path."
  }
}

variable "ml_synthetic_secret_payloads" {
  description = "Ephemeral base64-encoded Kubernetes Secret data for the isolated synthetic scorer. Values never enter Terraform state or plan files."
  type        = map(map(string))
  sensitive   = true
  ephemeral   = true
  default     = {}
  validation {
    condition = length(var.ml_synthetic_secret_payloads) == 0 || (
      toset(keys(var.ml_synthetic_secret_payloads)) == toset([
        "ml-synthetic-postgres-auth", "ml-synthetic-kafka-auth", "ml-synthetic-kafka-tls",
        "ml-scoring-runtime", "ml-scoring-migrator", "ml-scoring-fixture",
      ]) &&
      alltrue([
        for name, payload in var.ml_synthetic_secret_payloads :
        toset(keys(payload)) == {
          "ml-synthetic-postgres-auth" = toset(["bootstrap-password", "migrator-password", "runtime-password", "server.crt", "server.key", "ca.crt"])
          "ml-synthetic-kafka-auth"    = toset(["admin-password", "scorer-password", "fixture-password", "broker-jaas", "inter-broker-jaas"])
          "ml-synthetic-kafka-tls"     = toset(["broker.keystore.p12", "broker.truststore.p12", "keystore-password", "key-password", "truststore-password", "ca.crt"])
          "ml-scoring-runtime"         = toset(["database-url", "kafka-username", "kafka-password", "operations-token"])
          "ml-scoring-migrator"        = toset(["database-url"])
          "ml-scoring-fixture"         = toset(["kafka-username", "kafka-password"])
        }[name] &&
        # PKCS12 keystores are binary and Terraform base64decode rejects valid
        # non-UTF8 bytes. Validate the base64 envelope here; the sync runner
        # performs strict base64.b64decode(validate=True) before any K8s writes.
        alltrue([for encoded in values(payload) : length(encoded) > 0 && length(encoded) <= 50000 && length(encoded) % 4 == 0 && can(regex("^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$", encoded))])
      ])
    )
    error_message = "Synthetic payloads must be exactly the six documented Secret maps, with exactly their required keys and nonempty base64-encoded byte values (maximum 50 KB per field)."
  }
}

variable "ml_synthetic_secret_version" {
  description = "Fixed write-only version token for initial disposable synthetic credentials; in-place credential rotation is disabled."
  type        = number
  default     = 1
  validation {
    condition     = var.ml_synthetic_secret_version == 1
    error_message = "In-place synthetic credential rotation is disabled because PostgreSQL/Kafka persisted credentials would not rotate together; destroy and recreate the disposable cell instead."
  }
}

locals {
  ml_synthetic_secret_names = toset([
    "ml-synthetic-postgres-auth", "ml-synthetic-kafka-auth", "ml-synthetic-kafka-tls",
    "ml-scoring-runtime", "ml-scoring-migrator", "ml-scoring-fixture",
  ])
  ml_synthetic_scope = var.ml_synthetic_enabled ? {
    account_id  = var.target_account_id
    region      = var.aws_region
    environment = var.environment
    cell        = var.cluster_name
    cluster     = var.cluster_name
    namespace   = "ml-synthetic"
    sources     = { for name, secret in aws_secretsmanager_secret.ml_synthetic : name => secret.name }
    versions    = { for name, version in aws_secretsmanager_secret_version.ml_synthetic : name => version.version_id }
    } : {
    # Keep the false branch structurally identical. Terraform evaluates and
    # type-checks conditional results even when the disabled branch has count 0.
    account_id  = ""
    region      = ""
    environment = ""
    cell        = ""
    cluster     = ""
    namespace   = ""
    sources     = tomap({})
    versions    = tomap({})
  }
}

resource "terraform_data" "ml_synthetic_contract" {
  count      = var.ml_synthetic_enabled ? 1 : 0
  input      = { cell = var.cluster_name, environment = var.environment }
  depends_on = [terraform_data.destroy_inventory_sentinel]

  lifecycle {
    precondition {
      condition     = var.enable_application_tree && !contains(["prod", "production"], lower(var.environment)) && can(regex("^[0-9]{12}$", var.target_account_id))
      error_message = "Synthetic ML requires the enabled disposable application tree, a non-production environment, and the exact target AWS account."
    }
    precondition {
      condition     = var.ml_synthetic_scorer_image_digest != ""
      error_message = "Synthetic ML requires a CI-published, immutable scorer image digest from an approved repository."
    }
    precondition {
      condition     = toset(keys(var.ml_synthetic_secret_payloads)) == local.ml_synthetic_secret_names
      error_message = "Synthetic ML requires every isolated Secret payload before it can provision."
    }
  }
}

resource "aws_secretsmanager_secret" "ml_synthetic" {
  for_each   = var.ml_synthetic_enabled ? { for name in local.ml_synthetic_secret_names : name => name } : {}
  depends_on = [terraform_data.destroy_inventory_sentinel]

  # Keep multiple disposable cells in the same environment from sharing a
  # Secrets Manager name. The cell suffix is deterministic and non-secret.
  name                    = "greenguard/${var.environment}/cell-${substr(sha256(var.cluster_name), 0, 16)}/ml-synthetic/${each.key}"
  recovery_window_in_days = 0
  tags = merge(local.cell_tags, {
    Name        = "${var.cluster_name}-${each.key}"
    Lifecycle   = "Disposable"
    ManagedBy   = "Terraform"
    SecretOwner = "greenguard-ml-synthetic-secret-sync"
  })
}

resource "aws_secretsmanager_secret_version" "ml_synthetic" {
  for_each   = var.ml_synthetic_enabled ? aws_secretsmanager_secret.ml_synthetic : {}
  secret_id  = each.value.id
  depends_on = [terraform_data.destroy_inventory_sentinel]

  secret_string_wo         = jsonencode(var.ml_synthetic_secret_payloads[each.key])
  secret_string_wo_version = var.ml_synthetic_secret_version
  lifecycle {
    precondition {
      # These maps contain ASCII base64 values, so character and byte lengths match.
      condition     = length(jsonencode(var.ml_synthetic_secret_payloads[each.key])) <= 65536
      error_message = "Encoded SecretString exceeds the AWS 65536-byte limit; split the configuration before provisioning."
    }
  }
}

# Re-check the exact write-only values on every apply. Terraform intentionally
# cannot compare SecretString_wo values from state, so the short-lived process
# compares the ephemeral input with the exact AWS versions in memory. This
# prevents a regenerated bundle from updating the BFF token while PostgreSQL
# and Kafka continue using credentials from an older bundle.
resource "terraform_data" "ml_synthetic_secret_guard" {
  count = var.ml_synthetic_enabled ? 1 : 0
  input = {
    scope  = local.ml_synthetic_scope
    runner = abspath("${path.module}/../../gitops/disposable/ml-secret-lifecycle.py")
  }
  triggers_replace = timestamp()
  depends_on = [
    terraform_data.destroy_inventory_sentinel,
    aws_secretsmanager_secret_version.ml_synthetic,
  ]

  provisioner "local-exec" {
    command = "python3 ${self.input.runner} guard"
    environment = {
      GG_ML_SYNTHETIC_SCOPE                 = jsonencode(self.input.scope)
      GG_ML_SYNTHETIC_EXPECTED_FINGERPRINTS = jsonencode({ for name, payload in var.ml_synthetic_secret_payloads : name => { for key, value in payload : key => sha256(value) } })
    }
    quiet = true
  }
}

# This resource has no create-time provisioner. It survives a failed partial
# Secret sync and removes only its exact namespace's Terraform-owned Secrets.
resource "terraform_data" "ml_synthetic_namespace_cleanup" {
  count = var.ml_synthetic_enabled ? 1 : 0
  input = {
    scope  = local.ml_synthetic_scope
    runner = abspath("${path.module}/../../gitops/disposable/ml-secret-lifecycle.py")
  }
  depends_on = [
    terraform_data.ml_synthetic_contract,
    terraform_data.destroy_inventory_sentinel,
    aws_eks_access_policy_association.cluster_admin,
    aws_eks_node_group.general,
    aws_eks_node_group.compute,
    aws_eks_addon.ebs_csi,
    aws_iam_role.ebs_csi,
    aws_iam_role_policy_attachment.ebs_csi,
    helm_release.argocd,
    terraform_data.ml_synthetic_secret_cleanup,
  ]

  provisioner "local-exec" {
    when        = destroy
    command     = "python3 ${self.input.runner} namespace-destroy"
    environment = { GG_ML_SYNTHETIC_SCOPE = jsonencode(self.input.scope) }
    quiet       = true
  }
}

resource "terraform_data" "ml_synthetic_secret_cleanup" {
  count = var.ml_synthetic_enabled ? 1 : 0
  input = {
    scope  = local.ml_synthetic_scope
    runner = abspath("${path.module}/../../gitops/disposable/ml-secret-lifecycle.py")
  }
  # Destroy ordering: root Argo App -> sync token -> namespace/app cleanup ->
  # these Kubernetes Secrets -> AWS Secret versions. Creation is a no-op here.
  depends_on = [terraform_data.destroy_inventory_sentinel, aws_secretsmanager_secret_version.ml_synthetic,
  aws_eks_cluster.cell, aws_eks_access_policy_association.cluster_admin]

  provisioner "local-exec" {
    when        = destroy
    command     = "python3 ${self.input.runner} cleanup"
    environment = { GG_ML_SYNTHETIC_SCOPE = jsonencode(self.input.scope) }
    quiet       = true
  }
}

resource "terraform_data" "ml_synthetic_secret_sync" {
  count            = var.ml_synthetic_enabled ? 1 : 0
  input            = local.ml_synthetic_scope
  triggers_replace = local.ml_synthetic_scope.versions
  # Cleanup is created first, so it remains available even if apply sync fails.
  depends_on = [terraform_data.destroy_inventory_sentinel, terraform_data.ml_synthetic_secret_cleanup, aws_secretsmanager_secret_version.ml_synthetic, aws_eks_cluster.cell, aws_eks_node_group.general, aws_eks_access_policy_association.cluster_admin]

  provisioner "local-exec" {
    command     = "python3 ${path.module}/../../gitops/disposable/ml-secret-lifecycle.py apply"
    environment = { GG_ML_SYNTHETIC_SCOPE = jsonencode(self.input) }
    quiet       = true
  }
}
