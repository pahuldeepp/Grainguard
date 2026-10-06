# Existing OIDC is the default. These inputs are public identifiers, never secrets.
variable "identity_mode" {
  type    = string
  default = "existing-oidc"
  validation {
    condition     = contains(["existing-oidc", "managed-dex", "cognito"], var.identity_mode)
    error_message = "identity_mode must be existing-oidc, managed-dex, or explicit cognito opt-in."
  }
}

variable "existing_oidc" {
  description = "Existing issuer must support discovery, Authorization Code + PKCE, and JWT access tokens with this audience. Set mobile_audience_mode to scope for Dex cross-client scopes or query-param for providers that require audience=; register the exported callbacks."
  type = object({
    issuer                 = string
    jwks_url               = string
    authorization_endpoint = string
    token_endpoint         = string
    web_client_id          = string
    mobile_client_id       = string
    audience               = string
    scopes                 = optional(list(string), ["openid", "profile", "email", "offline_access"])
    token_mode             = optional(string, "audience")
    # Dex expresses the API audience as a cross-client scope; providers such as
    # Auth0 may instead require the conventional `audience=` query parameter.
    mobile_audience_mode = string
  })
  default = null
  validation {
    condition = var.existing_oidc == null ? true : alltrue([
      for endpoint in [var.existing_oidc.issuer, var.existing_oidc.jwks_url, var.existing_oidc.authorization_endpoint, var.existing_oidc.token_endpoint] :
      can(regex("^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]+)?(/[^?#]*)?$", endpoint)) &&
      !can(regex("^https://(localhost|127\\.0\\.0\\.1|([^/]+\\.)?example\\.com|[^/]+\\.invalid)([:/]|$)", endpoint))
    ])
    error_message = "OIDC endpoints must use deployed HTTPS hosts without credentials, query, fragment, or placeholders."
  }
  validation {
    condition = var.existing_oidc == null ? true : (
      alltrue([for id in [var.existing_oidc.web_client_id, var.existing_oidc.mobile_client_id] : can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$", id))]) &&
      length(trimspace(var.existing_oidc.audience)) > 0 && var.existing_oidc.audience == trimspace(var.existing_oidc.audience) && length(var.existing_oidc.audience) <= 200 &&
      var.existing_oidc.token_mode == "audience" &&
      contains(["scope", "query-param"], var.existing_oidc.mobile_audience_mode) &&
      (var.existing_oidc.mobile_audience_mode != "scope" || can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$", var.existing_oidc.audience))) &&
      toset(var.existing_oidc.scopes) == toset(["openid", "profile", "email", "offline_access"])
    )
    error_message = "Existing OIDC requires valid public client IDs, a nonempty access-token audience, audience token mode, mobile_audience_mode scope or query-param, a Dex-valid client ID when using scope mode, and the scopes currently requested by the dashboard: openid profile email offline_access."
  }
}

resource "terraform_data" "identity_contract" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  input      = var.identity_mode
  lifecycle {
    precondition {
      condition     = contains(["cognito", "managed-dex"], var.identity_mode) || var.existing_oidc != null
      error_message = "Supply existing_oidc for existing-oidc mode; managed-dex provisions Dex and Cognito requires explicit opt-in."
    }
    precondition {
      condition = var.identity_mode != "managed-dex" || (
        var.enable_application_tree &&
        contains(var.secret_names, "greenguard-dex-config") &&
        toset(keys(try(var.runtime_secret_values["greenguard-dex-config"], {}))) == toset(["DEX_FIRST_ADMIN_EMAIL", "DEX_FIRST_ADMIN_PASSWORD_HASH"])
      )
      error_message = "managed-dex requires enable_application_tree=true and greenguard-dex-config with an operator-chosen DEX_FIRST_ADMIN_EMAIL and bcrypt DEX_FIRST_ADMIN_PASSWORD_HASH; local demo users are never copied."
    }
  }
}

locals {
  cognito_prefix     = "gg-${substr(sha1("${var.target_account_id}:${var.cluster_name}"), 0, 24)}"
  cognito_issuer     = var.identity_mode == "cognito" ? "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.cell[0].id}" : null
  cognito_login      = var.identity_mode == "cognito" ? "https://${aws_cognito_user_pool_domain.cell[0].domain}.auth.${var.aws_region}.amazoncognito.com" : null
  managed_dex_issuer = "https://${aws_cloudfront_distribution.api.domain_name}/dex"
  managed_dex_public = {
    issuer                 = local.managed_dex_issuer
    jwks_url               = "${local.managed_dex_issuer}/keys"
    authorization_endpoint = "${local.managed_dex_issuer}/auth"
    token_endpoint         = "${local.managed_dex_issuer}/token"
    web_client_id          = "greenguard-dashboard"
    mobile_client_id       = "greenguard-mobile"
    audience               = "greenguard-dashboard"
    scopes                 = ["openid", "profile", "email", "offline_access"]
    token_mode             = "audience"
    mobile_audience_mode   = "scope"
  }
  oidc_public = var.identity_mode == "managed-dex" ? local.managed_dex_public : var.identity_mode == "cognito" ? {
    issuer                 = local.cognito_issuer
    jwks_url               = "${local.cognito_issuer}/.well-known/jwks.json"
    authorization_endpoint = "${local.cognito_login}/oauth2/authorize"
    token_endpoint         = "${local.cognito_login}/oauth2/token"
    web_client_id          = aws_cognito_user_pool_client.web[0].id
    mobile_client_id       = aws_cognito_user_pool_client.mobile[0].id
    audience               = ""
    scopes                 = ["openid", "profile", "email"]
    token_mode             = "cognito-access"
    mobile_audience_mode   = null
  } : var.existing_oidc
  oidc_verifier_env = local.oidc_public == null ? [] : [
    { name = "AUTH_TOKEN_MODE", value = local.oidc_public.token_mode },
    { name = "AUTH_ISSUER", value = local.oidc_public.issuer },
    { name = "AUTH_JWKS_URL", value = local.oidc_public.jwks_url },
    { name = "AUTH_AUDIENCE", value = local.oidc_public.audience },
    { name = "AUTH_COGNITO_CLIENT_IDS", value = var.identity_mode == "cognito" ? join(",", [local.oidc_public.web_client_id, local.oidc_public.mobile_client_id]) : "" },
  ]
  oidc_dashboard_values = local.oidc_public == null ? null : {
    publicOidc = {
      enabled        = true
      authority      = local.oidc_public.issuer
      clientId       = local.oidc_public.web_client_id
      tokenMode      = local.oidc_public.token_mode
      audience       = local.oidc_public.audience
      resource       = ""
      connectOrigins = distinct([for endpoint in [local.oidc_public.issuer, local.oidc_public.jwks_url, local.oidc_public.authorization_endpoint, local.oidc_public.token_endpoint] : regex("^https://[^/]+", endpoint)])
    }
  }
  oidc_mobile_config = local.oidc_public == null ? null : merge({
    authorizationEndpoint = local.oidc_public.authorization_endpoint
    tokenEndpoint         = local.oidc_public.token_endpoint
    bffEndpoint           = "https://${aws_cloudfront_distribution.api.domain_name}/graphql"
    clientId              = local.oidc_public.mobile_client_id
    scope                 = join(" ", local.oidc_public.scopes)
    }, contains(["existing-oidc", "managed-dex"], var.identity_mode) ? {
    audience     = local.oidc_public.audience
    audienceMode = local.oidc_public.mobile_audience_mode
  } : {})
}

resource "aws_cognito_user_pool" "cell" {
  depends_on               = [terraform_data.destroy_inventory_sentinel]
  count                    = var.identity_mode == "cognito" ? 1 : 0
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
  depends_on            = [terraform_data.destroy_inventory_sentinel]
  count                 = var.identity_mode == "cognito" ? 1 : 0
  domain                = local.cognito_prefix
  user_pool_id          = aws_cognito_user_pool.cell[0].id
  managed_login_version = 1
}

resource "aws_cognito_user_pool_client" "web" {
  count                                = var.identity_mode == "cognito" ? 1 : 0
  name                                 = "${local.edge_name}-web"
  user_pool_id                         = aws_cognito_user_pool.cell[0].id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls = [
    "https://${aws_cloudfront_distribution.web.domain_name}/auth/callback",
    "https://${aws_cloudfront_distribution.web.domain_name}/auth/silent-callback",
  ]
  logout_urls                   = ["https://${aws_cloudfront_distribution.web.domain_name}"]
  enable_token_revocation       = true
  prevent_user_existence_errors = "ENABLED"

  depends_on = [aws_cognito_user_pool_domain.cell,
    terraform_data.destroy_inventory_sentinel,
  ]
}

resource "aws_cognito_user_pool_client" "mobile" {
  count                                = var.identity_mode == "cognito" ? 1 : 0
  name                                 = "${local.edge_name}-mobile"
  user_pool_id                         = aws_cognito_user_pool.cell[0].id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["greenguard://auth/callback"]
  logout_urls                          = ["greenguard://auth/callback"]
  enable_token_revocation              = true
  prevent_user_existence_errors        = "ENABLED"

  depends_on = [aws_cognito_user_pool_domain.cell,
    terraform_data.destroy_inventory_sentinel,
  ]
}

output "oidc_public_configuration" {
  description = "Public provider-neutral OIDC configuration; no credentials or tokens."
  value = local.oidc_public == null ? null : merge(local.oidc_public, {
    authorize_endpoint     = local.oidc_public.authorization_endpoint
    web_callback           = "https://${aws_cloudfront_distribution.web.domain_name}/auth/callback"
    mobile_callback        = "greenguard://auth/callback"
    bff_allowed_client_ids = contains(["cognito", "managed-dex"], var.identity_mode) ? [local.oidc_public.web_client_id, local.oidc_public.mobile_client_id] : []
    bff_token_mode         = local.oidc_public.token_mode
    hosted_login_origin    = var.identity_mode == "cognito" ? local.cognito_login : null
  })
}

output "cognito_user_pool_id" {
  description = "Public pool ID only when Cognito was explicitly selected."
  value       = var.identity_mode == "cognito" ? aws_cognito_user_pool.cell[0].id : null
}

output "mobile_deployment_config" {
  description = "Public mobile configuration for configure.mjs; register greenguard://auth/callback at the selected issuer."
  value       = local.oidc_mobile_config
}

output "dashboard_helm_public_oidc_values" {
  description = "Public dashboard configuration and CSP connect origins for the selected issuer."
  value       = local.oidc_dashboard_values
}

# Preserve existing disposable Cognito addresses when explicitly retaining Cognito.
moved {
  from = aws_cognito_user_pool.cell
  to   = aws_cognito_user_pool.cell[0]
}
moved {
  from = aws_cognito_user_pool_domain.cell
  to   = aws_cognito_user_pool_domain.cell[0]
}
moved {
  from = aws_cognito_user_pool_client.web
  to   = aws_cognito_user_pool_client.web[0]
}
moved {
  from = aws_cognito_user_pool_client.mobile
  to   = aws_cognito_user_pool_client.mobile[0]
}
