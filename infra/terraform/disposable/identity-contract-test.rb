#!/usr/bin/env ruby
require 'minitest/autorun'

class IdentityContractTest < Minitest::Test
  SOURCE = File.read(File.join(__dir__, 'identity.tf'))

  def test_existing_identity_is_default_and_requires_public_configuration
    assert_match(/variable "identity_mode".*?default = "existing-oidc"/m, SOURCE)
    assert_includes SOURCE, 'var.identity_mode == "cognito" || var.existing_oidc != null'
    %w[issuer jwks_url authorization_endpoint token_endpoint web_client_id mobile_client_id audience scopes token_mode].each do |field|
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
    assert_includes SOURCE, 'var.identity_mode == "existing-oidc" ? { audience = local.oidc_public.audience } : {}'
    assert_includes SOURCE, 'mobile_callback        = "greenguard://auth/callback"'
    assert_includes SOURCE, '/auth/callback"'
    auth = File.read(File.expand_path('../../../apps/dashboard/src/auth.ts', __dir__))
    assert_includes auth, 'response_type: "code"'
    assert_includes auth, '"openid profile email offline_access"'
    assert_includes auth, 'user.access_token'
  end

  def test_verifier_and_public_configs_use_selected_identity
    %w[AUTH_TOKEN_MODE AUTH_ISSUER AUTH_JWKS_URL AUTH_AUDIENCE AUTH_COGNITO_CLIENT_IDS].each { |key| assert_includes SOURCE, "name = \"#{key}\"" }
    %w[oidc_public oidc_verifier_env oidc_dashboard_values oidc_mobile_config].each { |key| assert_match(/^\s+#{key}\s+=/, SOURCE) }
    assert_includes SOURCE, 'value       = local.oidc_mobile_config'
    assert_includes SOURCE, 'value       = local.oidc_dashboard_values'
    refute_match(/variable "[^\"]*(password|secret|token_value)/, SOURCE)
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
