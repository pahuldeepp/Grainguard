# Dex remains the local/test issuer. For a disposable AWS cell with no
# pre-existing production identity provider, Cognito supplies a durable OIDC
# issuer without replacing GreenGuard's Authorization Code + PKCE clients or
# its BFF-side issuer/client/membership validation. No user credentials or
# membership records enter Terraform state.
locals {
  cognito_prefix = "gg-${substr(sha1("${var.target_account_id}:${var.cluster_name}"), 0, 24)}"
  cognito_issuer = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.cell.id}"
  cognito_login  = "https://${aws_cognito_user_pool_domain.cell.domain}.auth.${var.aws_region}.amazoncognito.com"
}

resource "aws_cognito_user_pool" "cell" {
  name                     = "${local.edge_name}-users"
  deletion_protection      = "INACTIVE"
  user_pool_tier           = "LITE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  tags                     = { Cell = var.cluster_name }

  # An invitation must be paired with an authoritative tenant membership.
  # A Cognito account alone never grants GreenGuard tenant data access.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }
}

resource "aws_cognito_user_pool_domain" "cell" {
  domain                = local.cognito_prefix
  user_pool_id          = aws_cognito_user_pool.cell.id
  managed_login_version = 1
}

resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${local.edge_name}-web"
  user_pool_id                         = aws_cognito_user_pool.cell.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["https://${aws_cloudfront_distribution.web.domain_name}/auth/callback"]
  logout_urls                          = ["https://${aws_cloudfront_distribution.web.domain_name}"]
  enable_token_revocation              = true
  prevent_user_existence_errors        = "ENABLED"

  depends_on = [aws_cognito_user_pool_domain.cell]
}

resource "aws_cognito_user_pool_client" "mobile" {
  name                                 = "${local.edge_name}-mobile"
  user_pool_id                         = aws_cognito_user_pool.cell.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["greenguard://auth/callback"]
  logout_urls                          = ["greenguard://auth/callback"]
  enable_token_revocation              = true
  prevent_user_existence_errors        = "ENABLED"

  depends_on = [aws_cognito_user_pool_domain.cell]
}

output "oidc_public_configuration" {
  description = "Public OIDC inputs for dashboard Helm and mobile release configuration; never contains user credentials or tokens."
  value = {
    issuer                 = local.cognito_issuer
    jwks_url               = "${local.cognito_issuer}/.well-known/jwks.json"
    authorize_endpoint     = "${local.cognito_login}/oauth2/authorize"
    token_endpoint         = "${local.cognito_login}/oauth2/token"
    hosted_login_origin    = local.cognito_login
    web_client_id          = aws_cognito_user_pool_client.web.id
    mobile_client_id       = aws_cognito_user_pool_client.mobile.id
    web_callback           = "https://${aws_cloudfront_distribution.web.domain_name}/auth/callback"
    mobile_callback        = "greenguard://auth/callback"
    bff_allowed_client_ids = [aws_cognito_user_pool_client.web.id, aws_cognito_user_pool_client.mobile.id]
    bff_token_mode         = "cognito-access"
  }
}

output "cognito_user_pool_id" {
  description = "Public pool identifier for account-guarded operator user invitation and first-admin enrollment."
  value       = aws_cognito_user_pool.cell.id
}

output "mobile_deployment_config" {
  description = "Write `terraform output -json mobile_deployment_config > apps/mobile/shell/deployment.local.json`, then run the mobile configure script before an iPhone build. Public endpoints and client ID only."
  value = {
    authorizationEndpoint = "${local.cognito_login}/oauth2/authorize"
    tokenEndpoint         = "${local.cognito_login}/oauth2/token"
    bffEndpoint           = "https://${aws_cloudfront_distribution.api.domain_name}/graphql"
    clientId              = aws_cognito_user_pool_client.mobile.id
    scope                 = "openid email profile"
  }
}

output "dashboard_helm_public_oidc_values" {
  description = "Supply this map to the dashboard Helm release after CloudFront and Cognito exist. It renders public /config.json and the hosted-domain CSP connect origin."
  value = {
    publicOidc = {
      enabled        = true
      authority      = local.cognito_issuer
      clientId       = aws_cognito_user_pool_client.web.id
      tokenMode      = "cognito-access"
      audience       = ""
      resource       = ""
      connectOrigins = [local.cognito_login]
    }
  }
}
