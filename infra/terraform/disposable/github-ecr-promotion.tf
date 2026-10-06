# Short-lived GitHub Actions federation for explicit GHCR -> ECR promotion.
# The account-level GitHub OIDC provider is intentionally supplied by ARN:
# this cell must not create or delete an issuer shared by other repositories.
variable "enable_github_actions_ecr_promotion" {
  description = "Create a least-privilege, cell-scoped role for the protected manual ECR promotion workflow. Requires an existing GitHub OIDC provider."
  type        = bool
  default     = false
  validation {
    condition     = !var.enable_github_actions_ecr_promotion || var.github_actions_oidc_provider_arn != ""
    error_message = "Enable GitHub ECR promotion only after supplying the existing account's GitHub Actions OIDC provider ARN."
  }
}

variable "github_actions_oidc_provider_arn" {
  description = "Existing account-level IAM OIDC provider ARN for https://token.actions.githubusercontent.com. The disposable cell never owns this shared provider."
  type        = string
  default     = ""
  validation {
    condition     = var.github_actions_oidc_provider_arn == "" || can(regex("^arn:aws:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$", var.github_actions_oidc_provider_arn))
    error_message = "github_actions_oidc_provider_arn must be the IAM provider ARN for token.actions.githubusercontent.com."
  }
}

locals {
  github_ecr_promotion_environment = "greenguard-ecr-promotion"
  github_ecr_promotion_role_name   = "gg-ecr-promote-${var.environment}-${substr(sha256(var.cluster_name), 0, 16)}"
}

data "aws_iam_openid_connect_provider" "github_actions_ecr_promotion" {
  count = var.enable_github_actions_ecr_promotion ? 1 : 0
  arn   = var.github_actions_oidc_provider_arn

  lifecycle {
    precondition {
      condition     = var.github_actions_oidc_provider_arn != ""
      error_message = "ECR promotion role requires an existing GitHub Actions OIDC provider ARN; the shared provider must be provisioned/imported outside this disposable cell."
    }
    precondition {
      condition     = var.target_account_id == "" || can(regex("^arn:aws:iam::${var.target_account_id}:oidc-provider/token\\.actions\\.githubusercontent\\.com$", var.github_actions_oidc_provider_arn))
      error_message = "GitHub OIDC provider must belong to target_account_id."
    }
  }
}

resource "aws_iam_role" "github_actions_ecr_promotion" {
  count = var.enable_github_actions_ecr_promotion ? 1 : 0
  name  = local.github_ecr_promotion_role_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = data.aws_iam_openid_connect_provider.github_actions_ecr_promotion[0].arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:pahuldeepp/Grainguard:environment:${local.github_ecr_promotion_environment}"
        }
      }
    }]
  })

  lifecycle {
    precondition {
      condition     = !contains(["prod", "production"], lower(var.environment))
      error_message = "The disposable ECR promotion role is forbidden in production environments."
    }
    precondition {
      condition     = trimprefix(data.aws_iam_openid_connect_provider.github_actions_ecr_promotion[0].url, "https://") == "token.actions.githubusercontent.com"
      error_message = "ECR promotion only trusts the GitHub Actions OIDC issuer."
    }
  }

  tags       = merge(local.cell_tags, { Name = local.github_ecr_promotion_role_name })
  depends_on = [terraform_data.destroy_inventory_sentinel]
}

resource "aws_iam_role_policy" "github_actions_ecr_promotion" {
  count = var.enable_github_actions_ecr_promotion ? 1 : 0
  name  = "cell-ecr-image-promotion"
  role  = aws_iam_role.github_actions_ecr_promotion[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeRepositories",
          "ecr:DescribeImages",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart"
        ]
        Resource = [for repository in values(aws_ecr_repository.runtime) : repository.arn]
      }
    ]
  })

  depends_on = [terraform_data.destroy_inventory_sentinel]
}

output "github_actions_ecr_promotion_role_arn" {
  description = "Short-lived GitHub OIDC role for the protected ECR promotion workflow; null unless explicitly enabled."
  value       = try(aws_iam_role.github_actions_ecr_promotion[0].arn, null)
}
