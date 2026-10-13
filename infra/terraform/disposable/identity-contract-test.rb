#!/usr/bin/env ruby
require 'minitest/autorun'

class IdentityContractTest < Minitest::Test
  SOURCE = File.read(File.join(__dir__, 'identity.tf'))

  def test_existing_identity_is_default_and_requires_public_configuration
    assert_match(/variable "identity_mode".*?default = "existing-oidc"/m, SOURCE)
    assert_includes SOURCE, 'contains(["cognito", "managed-dex"], var.identity_mode) || var.existing_oidc != null'
    %w[issuer jwks_url authorization_endpoint token_endpoint web_client_id mobile_client_id audience scopes token_mode mobile_audience_mode].each do |field|
      assert_match(/^\s+#{field}\s+=/, SOURCE)
    end
  end

  def test_all_cognito_resources_require_explicit_opt_in
    resources = SOURCE.scan(/resource "(aws_cognito_[^"]+)" "([^"]+)" \{(.*?)(?=\nresource |\noutput |\z)/m)
    assert_equal 4, resources.length
    resources.each { |_, _, body| assert_match(/count\s+= var.identity_mode == "cognito" \? 1 : 0/, body) }
    refute_match(/aws_cognito_[\w]+\.[\w]+\.(id|domain)/, SOURCE)
    assert_includes SOURCE, 'var.identity_mode == "cognito" ? aws_cognito_user_pool.cell[0].id : null'
  end

  def test_audience_mode_matches_actual_client_contract
    assert_includes SOURCE, 'var.existing_oidc.token_mode == "audience"'
    assert_includes SOURCE, 'length(trimspace(var.existing_oidc.audience)) > 0'
    assert_includes SOURCE, 'toset(var.existing_oidc.scopes) == toset(["openid", "profile", "email", "offline_access"])'
    assert_includes SOURCE, 'contains(["scope", "query-param"], var.existing_oidc.mobile_audience_mode)'
    assert_match(/mobile_audience_mode\s+= string/, SOURCE)
    assert_includes SOURCE, 'var.existing_oidc.mobile_audience_mode != "scope" || can(regex('
    assert_includes SOURCE, 'audienceMode = local.oidc_public.mobile_audience_mode'
    assert_includes SOURCE, 'audience     = local.oidc_public.audience'
    assert_includes SOURCE, 'scope                 = join(" ", local.oidc_public.scopes)'
    assert_includes SOURCE, 'mobile_callback        = "greenguard://auth/callback"'
    assert_includes SOURCE, '/auth/callback"'
    auth = File.read(File.expand_path('../../../apps/dashboard/src/auth.ts', __dir__))
    assert_includes auth, 'response_type: "code"'
    assert_includes auth, '"openid profile email offline_access"'
    assert_includes auth, 'user.access_token'
  end

  def test_web_cognito_client_registers_both_pkce_and_silent_callback_urls
    assert_includes SOURCE, '/auth/callback'
    assert_includes SOURCE, '/auth/silent-callback'
    dex = File.read(File.expand_path('../../gitops/disposable/dex-chart/templates/dex.yaml', __dir__))
    assert_includes dex, '${DEX_DASHBOARD_ORIGIN}/auth/silent-callback'
  end

  def test_dex_scope_mode_is_trusted_and_mobile_pkce_does_not_send_audience_query
    dex = File.read(File.expand_path('../../oidc/dex.yaml.tpl', __dir__))
    assert_includes dex, 'id: greenguard-dashboard'
    assert_includes dex, 'trustedPeers:'
    assert_match(/id: greenguard-dashboard.*?trustedPeers:\s+- greenguard-mobile/m, dex)
    assert_includes dex, 'audience:server:client_id:greenguard-dashboard'
    pkce = File.read(File.expand_path('../../../apps/mobile/src/pkce.ts', __dir__))
    assert_includes pkce, 'audience:server:client_id:${config.audience}'
    assert_includes pkce, 'config.audienceMode !== "scope"'
    assert_includes pkce, 'params.set("audience", config.audience)'
    pkce_tests = File.read(File.expand_path('../../../apps/mobile/src/pkce.test.ts', __dir__))
    assert_includes pkce_tests, 'Dex scope audience is requested as a scope without an audience query parameter'
    assert_includes pkce_tests, 'url.searchParams.has("audience"), false'
  end

  def test_verifier_and_public_configs_use_selected_identity
    %w[AUTH_TOKEN_MODE AUTH_ISSUER AUTH_JWKS_URL AUTH_AUDIENCE AUTH_COGNITO_CLIENT_IDS].each { |key| assert_includes SOURCE, "name = \"#{key}\"" }
    %w[oidc_public oidc_verifier_env oidc_dashboard_values oidc_mobile_config].each { |key| assert_match(/^\s+#{key}\s+=/, SOURCE) }
    assert_includes SOURCE, 'value       = local.oidc_mobile_config'
    assert_includes SOURCE, 'value       = local.oidc_dashboard_values'
    refute_match(/variable "[^\"]*(password|secret|token_value)/, SOURCE)
  end

  def test_managed_dex_preserves_oidc_and_uses_the_public_api_cloudfront_issuer
    assert_includes SOURCE, '"existing-oidc", "managed-dex", "cognito"'
    assert_includes SOURCE, 'https://${aws_cloudfront_distribution.api.domain_name}/dex'
    assert_includes SOURCE, 'mobile_audience_mode   = "scope"'
    assert_includes SOURCE, 'DEX_FIRST_ADMIN_PASSWORD_HASH'
    assert_includes SOURCE, 'bcrypt'
    assert_includes SOURCE, 'var.identity_mode == "managed-dex" ? local.managed_dex_public'
    chart = File.read(File.expand_path('../../gitops/disposable/dex-chart/templates/dex.yaml', __dir__))
    assert_includes chart, 'type: postgres'
    assert_includes chart, 'mode: verify-full'
    assert_includes chart, 'enforce: true'
    assert_includes chart, '${DEX_FIRST_ADMIN_PASSWORD_HASH}'
    refute_match(/alice@greenguard\.test|victor@greenguard\.test|bob@greenguard\.test/, chart)
  end

  def test_first_admin_enrollment_is_provider_neutral_and_token_verified
    verifier = File.read(File.expand_path('../../../services/tenant-control-plane/src/enroll-first-admin-token.ts', __dir__))
    cli = File.read(File.expand_path('../../../services/tenant-control-plane/src/enroll-first-admin-cli.ts', __dir__))
    %w[issuer audience tokenMode].each { |claim| assert_includes verifier, claim }
    assert_includes verifier, 'createTokenVerifier'
    assert_includes verifier, 'jwksUrl'
    assert_includes cli, 'verifyFirstAdminAccessToken'
    refute_includes cli, 'admin-get-user'
    enrollment = File.read(File.expand_path('../../../services/tenant-control-plane/src/enroll-first-admin.ts', __dir__))
    assert_includes enrollment, 'verified, bounded OIDC sub claim'
    refute_includes enrollment, 'Cognito user-pool issuer'
  end

  def test_public_kubernetes_endpoint_refuses_production_aliases_case_insensitively
    variables = File.read(File.join(__dir__, 'variables.tf'))
    assert_includes variables, 'contains(["prod", "production"], lower(var.environment))'
  end
end
