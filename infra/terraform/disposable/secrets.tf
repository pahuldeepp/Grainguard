# Create containers for approved secret values only. External Secrets can
# later sync them into the cluster; values are written out of band and never
# enter Terraform state. A zero-day recovery window requests immediate deletion
# for this disposable environment during terraform destroy.
resource "aws_secretsmanager_secret" "runtime" {
  for_each = var.secret_names

  name                    = "greenguard/${var.environment}/${each.value}"
  recovery_window_in_days = 0

  tags = { Cell = var.cluster_name }
}

variable "secret_names" {
  description = "Approved secret names to create, excluding values. Values must be written through an operator secret workflow."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for name in var.secret_names : can(regex("^[a-z0-9][a-z0-9/_-]{0,120}$", name))])
    error_message = "secret_names must contain only lowercase path names."
  }
}

output "secret_arns" {
  value = { for name, secret in aws_secretsmanager_secret.runtime : name => secret.arn }
}

variable "target_account_id" {
  description = "Exact AWS account allowed for this disposable cell. Provider initialization rejects other accounts."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.target_account_id))
    error_message = "target_account_id must be a 12-digit AWS account ID."
  }
}
