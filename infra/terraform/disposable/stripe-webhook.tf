variable "manage_stripe_webhook" {
  description = "Register and tear down the disposable Stripe test webhook against this cell's API CloudFront endpoint."
  type        = bool
  default     = true
}

locals {
  managed_stripe_webhook = var.enable_application_tree && var.manage_stripe_webhook
  stripe_webhook_scope = local.managed_stripe_webhook ? {
    account_id   = var.target_account_id
    region       = var.aws_region
    environment  = var.environment
    cluster      = var.cluster_name
    secret_arn   = aws_secretsmanager_secret.runtime["billing-service-config"].arn
    seed_version = aws_secretsmanager_secret_version.runtime["billing-service-config"].version_id
    url          = "https://${aws_cloudfront_distribution.api.domain_name}/webhooks/stripe"
  } : null
}

# A separate ownership record survives a failed/tainted create provisioner.
# It runs before the billing source secret and CloudFront endpoint are removed.
resource "terraform_data" "stripe_webhook_cleanup" {
  count      = local.managed_stripe_webhook ? 1 : 0
  depends_on = [terraform_data.destroy_inventory_sentinel]
  input = {
    scope  = local.stripe_webhook_scope
    runner = abspath("${path.module}/../../gitops/disposable/stripe-webhook-lifecycle.py")
  }
  triggers_replace = local.stripe_webhook_scope
  provisioner "local-exec" {
    when        = destroy
    command     = "python3 ${self.input.runner} destroy"
    environment = { GG_STRIPE_WEBHOOK_SCOPE = jsonencode(self.input.scope) }
    quiet       = true
  }
}

resource "terraform_data" "stripe_webhook_apply" {
  count            = local.managed_stripe_webhook ? 1 : 0
  input            = local.stripe_webhook_scope
  triggers_replace = local.stripe_webhook_scope
  depends_on       = [terraform_data.stripe_webhook_cleanup, terraform_data.destroy_inventory_sentinel]
  provisioner "local-exec" {
    command     = "python3 ${path.module}/../../gitops/disposable/stripe-webhook-lifecycle.py apply"
    environment = { GG_STRIPE_WEBHOOK_SCOPE = jsonencode(self.input) }
    quiet       = true
  }
}

# This metadata-only data source never returns the secret string. Kubernetes
# sync must use the final version containing the cell's actual Stripe signer.
data "aws_secretsmanager_secret_versions" "stripe_webhook" {
  count              = local.managed_stripe_webhook ? 1 : 0
  secret_id          = aws_secretsmanager_secret.runtime["billing-service-config"].id
  include_deprecated = false
  depends_on         = [terraform_data.stripe_webhook_apply]
}
