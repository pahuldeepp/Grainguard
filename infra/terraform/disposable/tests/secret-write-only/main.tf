terraform {
  required_version = ">= 1.16.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.60.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

variable "secret_name" {
  type = string
}

variable "secret_payload" {
  type      = map(string)
  sensitive = true
  ephemeral = true
}

variable "version_counter" {
  type = number
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = var.secret_name
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "runtime" {
  secret_id                = aws_secretsmanager_secret.runtime.id
  secret_string_wo         = jsonencode(var.secret_payload)
  secret_string_wo_version = var.version_counter
}
