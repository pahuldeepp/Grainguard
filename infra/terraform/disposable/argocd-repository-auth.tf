resource "aws_secretsmanager_secret" "argocd_repository" {
  count                   = var.enable_application_tree ? 1 : 0
  name                    = "greenguard/${var.environment}/argocd-repository"
  recovery_window_in_days = 0
  tags = {
    Cell                 = var.cluster_name
    RuntimeSecretOwner   = "greenguard-argocd-repository-sync"
    RepositoryCredential = "read-only-deploy-key"
  }

  depends_on = [terraform_data.destroy_inventory_sentinel]
}

resource "aws_secretsmanager_secret_version" "argocd_repository" {
  count                    = var.enable_application_tree ? 1 : 0
  secret_id                = aws_secretsmanager_secret.argocd_repository[0].id
  secret_string_wo         = jsonencode({ SSH_PRIVATE_KEY = var.gitops_repository_private_key })
  secret_string_wo_version = var.gitops_repository_key_version
  depends_on               = [terraform_data.destroy_inventory_sentinel]

  lifecycle {
    precondition {
      condition     = length(var.gitops_repository_private_key) > 0
      error_message = "The private GitHub repository requires a fresh read-only Ed25519 deploy key in the ephemeral gitops_repository_private_key input. Register only its public half on this repo; do not use a broad GitHub CLI token."
    }
  }
}

locals {
  argocd_repository_sync_scope = var.enable_application_tree ? {
    account_id     = var.target_account_id
    region         = var.aws_region
    environment    = var.environment
    cluster        = var.cluster_name
    repository     = var.gitops_repository_url
    secret_arn     = aws_secretsmanager_secret.argocd_repository[0].arn
    secret_name    = aws_secretsmanager_secret.argocd_repository[0].name
    secret_version = aws_secretsmanager_secret_version.argocd_repository[0].version_id
  } : {}
}

resource "terraform_data" "argocd_repository_secret_sync" {
  count            = var.enable_application_tree ? 1 : 0
  input            = local.argocd_repository_sync_scope
  triggers_replace = local.argocd_repository_sync_scope

  provisioner "local-exec" {
    command     = "python3 ${path.module}/../../gitops/disposable/argocd-repository-secret-lifecycle.py apply"
    environment = { GG_ARGOCD_REPOSITORY_SCOPE = jsonencode(self.input) }
    quiet       = true
  }
  depends_on = [
    aws_secretsmanager_secret_version.argocd_repository,
    helm_release.argocd,
    terraform_data.eks_api_reachability,
    terraform_data.destroy_inventory_sentinel,
  ]
}

# Keep cleanup separate from the create-provisioner resource so Terraform will
# still remove the repository credential if the initial sync resource is tainted.
resource "terraform_data" "argocd_repository_secret_cleanup" {
  count            = var.enable_application_tree ? 1 : 0
  input            = local.argocd_repository_sync_scope
  triggers_replace = local.argocd_repository_sync_scope

  provisioner "local-exec" {
    when        = destroy
    command     = "python3 ${path.module}/../../gitops/disposable/argocd-repository-secret-lifecycle.py destroy"
    environment = { GG_ARGOCD_REPOSITORY_SCOPE = jsonencode(self.input) }
    quiet       = true
  }
  depends_on = [
    terraform_data.argocd_repository_secret_sync,
    terraform_data.destroy_inventory_sentinel,
  ]
}
