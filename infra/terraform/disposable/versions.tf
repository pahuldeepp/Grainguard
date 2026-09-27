terraform {
  required_version = ">= 1.16.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.60.0"
    }
  }

  # This disposable cell owns its whole state locally. Keep the state file and
  # backups until destroy and the post-destroy resource inventory both pass.
  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.target_account_id]

  default_tags {
    tags = merge(var.tags, {
      Project     = "GreenGuard"
      Environment = var.environment
      ManagedBy   = "Terraform"
      Lifecycle   = "Disposable"
    })
  }
}
