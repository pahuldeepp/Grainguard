terraform {
  required_version = ">= 1.16.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.60.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "= 3.3.0"
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

# CloudFront WAFv2 is global and must be managed through us-east-1 even when
# the EKS cell itself runs in another region.
provider "aws" {
  alias               = "global"
  region              = "us-east-1"
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
