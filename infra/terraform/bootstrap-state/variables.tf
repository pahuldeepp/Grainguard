variable "aws_region" {
  description = "Region that owns the Terraform state bucket."
  type        = string
}

variable "state_bucket_name" {
  description = "Globally unique, operator-selected S3 bucket name for Terraform state."
  type        = string
  validation {
    condition     = length(var.state_bucket_name) >= 3 && length(var.state_bucket_name) <= 63 && can(regex("^[a-z0-9][a-z0-9.-]+[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be a valid 3-63 character S3 bucket name."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
