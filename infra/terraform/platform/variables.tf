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
  description = "Approved operator/VPN CIDRs allowed to reach a public EKS API endpoint."
  type        = list(string)
  default     = []
  validation {
    condition     = (length(var.cluster_endpoint_public_access_cidrs) == 0 || alltrue([for cidr in var.cluster_endpoint_public_access_cidrs : can(cidrhost(cidr, 0))])) && (!var.cluster_endpoint_public_access || length(var.cluster_endpoint_public_access_cidrs) > 0)
    error_message = "Public endpoint access requires at least one valid IPv4/IPv6 CIDR."
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
  description = "Immutable ECR repository names provisioned for runtime release images."
  type        = set(string)
  default = [
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
