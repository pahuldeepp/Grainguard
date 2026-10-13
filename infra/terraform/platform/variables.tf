variable "aws_region" {
  description = "AWS region for this GreenGuard cell."
  type        = string
}

variable "environment" {
  description = "Deployment environment identifier."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment must be a 2-16 character lowercase identifier."
  }
}

variable "cluster_name" {
  description = "Unique EKS cluster name for this environment/cell."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$", var.cluster_name))
    error_message = "cluster_name must be a valid EKS cluster identifier."
  }
}

variable "kubernetes_version" {
  description = "Explicit EKS Kubernetes version currently supported in aws_region."
  type        = string
  validation {
    condition     = can(regex("^1\\.[0-9]{2}$", var.kubernetes_version))
    error_message = "kubernetes_version must use the explicit 1.NN format."
  }
}

variable "vpc_cni_addon_version" {
  description = "Exact VPC CNI add-on version supported in the selected EKS region; must support Kubernetes NetworkPolicy."
  type        = string
  validation {
    condition     = can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+-eksbuild\\.[0-9]+$", var.vpc_cni_addon_version))
    error_message = "vpc_cni_addon_version must be an explicit vX.Y.Z-eksbuild.N release."
  }
}

variable "vpc_cidr" {
  description = "Non-overlapping VPC CIDR reserved for this cell."
  type        = string
  default     = "10.60.0.0/16"
  validation {
    condition     = can(cidrsubnet(var.vpc_cidr, 4, 11))
    error_message = "vpc_cidr must allow at least 12 subnet blocks after adding four subnet bits."
  }
}

variable "availability_zones" {
  description = "At least two operator-confirmed AZ names in aws_region."
  type        = list(string)
  validation {
    condition     = length(var.availability_zones) >= 2 && length(distinct(var.availability_zones)) == length(var.availability_zones) && length(var.availability_zones) <= 4
    error_message = "availability_zones must contain 2-4 unique AZ names."
  }
}

variable "cluster_admin_role_arn" {
  description = "Existing IAM role granted EKS cluster-admin access; provision identity outside this stack."
  type        = string
  validation {
    condition     = can(regex("^arn:[^:]+:iam::[0-9]{12}:role/.+", var.cluster_admin_role_arn))
    error_message = "cluster_admin_role_arn must be a valid IAM role ARN."
  }
}

variable "cluster_endpoint_public_access" {
  description = "Enable a public Kubernetes API endpoint only when CIDRs are explicitly restricted."
  type        = bool
  default     = false
}

variable "cluster_endpoint_public_access_cidrs" {
  description = "Approved operator/VPN CIDRs allowed to reach a non-production public EKS API endpoint. Never use an all-addresses CIDR."
  type        = list(string)
  default     = []
  validation {
    condition     = (length(var.cluster_endpoint_public_access_cidrs) == 0 || alltrue([for cidr in var.cluster_endpoint_public_access_cidrs : can(cidrhost(cidr, 0)) && try(tonumber(split("/", cidr)[1]), 0) > 0])) && (!var.cluster_endpoint_public_access || (!contains(["prod", "production"], lower(var.environment)) && length(var.cluster_endpoint_public_access_cidrs) > 0))
    error_message = "Public EKS API access is non-production only and requires explicit valid operator CIDRs; 0.0.0.0/0 and ::/0 are forbidden."
  }
}

variable "general_instance_types" {
  description = "General-purpose EKS node instance types for APIs and platform services."
  type        = list(string)
  default     = ["m7i.large"]
}

variable "general_node_min_size" {
  type    = number
  default = 2
  validation {
    condition     = var.general_node_min_size >= 1 && var.general_node_desired_size >= var.general_node_min_size && var.general_node_max_size >= var.general_node_desired_size
    error_message = "General node sizes must satisfy 1 <= min <= desired <= max."
  }
}

variable "general_node_desired_size" {
  type    = number
  default = 3
}

variable "general_node_max_size" {
  type    = number
  default = 6
}

variable "compute_instance_types" {
  description = "Larger instance options for event/compute workers on a tainted pool."
  type        = list(string)
  default     = ["m7i.xlarge"]
}

variable "compute_node_max_size" {
  type    = number
  default = 4
  validation {
    condition     = var.compute_node_max_size >= 1
    error_message = "compute_node_max_size must be at least 1."
  }
}

variable "image_repositories" {
  description = "Immutable ECR repository names provisioned for runtime releases and separately built migration/tool images."
  type        = set(string)
  default = [
    "knowledge-service",
    "knowledge-indexer",
    "knowledge-parser",
    "grain-advisor",
    "model-gateway",
    "model-gateway-usage",
    "mcp-gateway",
    "dashboard",
    "bff",
    "gateway",
    "device-service",
    "read-api",
    "workflow-alerts",
    "telemetry-ingest",
    "cdc-transformer",
    "projection-builder",
    "cache-invalidator",
    "risk-engine",
    "hardware-service",
    "eventbridge-bridge",
    "saga-orchestrator",
    "tenant-control-plane",
    "billing-service",
    "notification-service",
    "jobs-worker",
    "cassandra-writer",
    "search-indexer",
    "migration-control",
    "migration-billing",
    "migration-telemetry",
    "migration-projection",
    "migration-jobs",
    "migration-saga",
    "migration-hardware",
    "migration-inventory",
    "migration-alerts",
    "migration-risk",
    "migration-notifications",
    "migration-gate",
    "migration-sql",
    "ml-scoring-synthetic",
    "otel-collector",
    "prometheus",
    "grafana",
    "tempo",
    "loki",
    "pgbouncer",
    "kafka-topics",
    "kafka-connect",
    "connector-registration",
    "opensearch",
    "cassandra",
    "mqtt",
    "clickhouse",
    "telemetry-sinks",
    "clamav",
  ]
}

variable "delete_nonempty_ecr_on_destroy" {
  description = "Delete ECR repositories with images during destroy. Enable only for a disposable environment whose images may be discarded."
  type        = bool
  default     = false
}

variable "kms_deletion_window_days" {
  description = "Waiting period before AWS deletes the EKS secrets KMS key after destroy (AWS allows 7-30 days; a pending key is not billed)."
  type        = number
  default     = 30
  validation {
    condition     = var.kms_deletion_window_days >= 7 && var.kms_deletion_window_days <= 30
    error_message = "kms_deletion_window_days must be between 7 and 30."
  }
}

variable "eventbridge_event_bus_arn" {
  description = "Existing GreenGuard alert EventBridge bus ARN; paired with the quarantine queue ARN, this enables the bridge's least-privilege Pod Identity association."
  type        = string
  default     = ""
  validation {
    condition     = var.eventbridge_event_bus_arn == "" || can(regex("^arn:[^:]+:events:[^:]+:[0-9]{12}:event-bus/.+$", var.eventbridge_event_bus_arn))
    error_message = "eventbridge_event_bus_arn must be empty or an EventBridge event-bus ARN."
  }
}

variable "bridge_quarantine_queue_arn" {
  description = "Existing SQS quarantine queue ARN; paired with eventbridge_event_bus_arn, this enables the bridge's Pod Identity association."
  type        = string
  default     = ""
  validation {
    condition     = var.bridge_quarantine_queue_arn == "" || can(regex("^arn:[^:]+:sqs:[^:]+:[0-9]{12}:.+$", var.bridge_quarantine_queue_arn))
    error_message = "bridge_quarantine_queue_arn must be empty or an SQS queue ARN."
  }
}

variable "tags" {
  description = "Additional non-sensitive resource tags."
  type        = map(string)
  default     = {}
}

variable "enable_disposable_destroy_sentinel" {
  description = "Enable the post-destroy inventory sentinel in the disposable cell root; leave disabled for shared platform root users."
  type        = bool
  default     = false
}

variable "target_account_id" {
  description = "Exact AWS account allowed for the disposable cell. Required when the disposable destroy sentinel is enabled."
  type        = string
  default     = ""
  validation {
    condition     = var.target_account_id == "" ? !var.enable_disposable_destroy_sentinel : can(regex("^[0-9]{12}$", var.target_account_id))
    error_message = "Set target_account_id to the 12-digit disposable AWS account ID when the destroy sentinel is enabled."
  }
}

variable "managed_dex_image_digest" {
  description = "Immutable official Dex OCI image digest used only for identity_mode=managed-dex."
  type        = string
  default     = "ghcr.io/dexidp/dex:v2.41.1@sha256:bc7cfce7c17f52864e2bb2a4dc1d2f86a41e3019f6d42e81d92a301fad0c8a1d"
  validation {
    condition     = can(regex("^ghcr\\.io/dexidp/dex:v2\\.[0-9]+\\.[0-9]+@sha256:[a-f0-9]{64}$", var.managed_dex_image_digest))
    error_message = "managed_dex_image_digest must be a versioned Dex image pinned to an OCI SHA-256 digest."
  }
}
