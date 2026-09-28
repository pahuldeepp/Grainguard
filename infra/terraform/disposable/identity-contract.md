# Disposable identity contract

`identity_mode` defaults to `existing-oidc`. Supply the public `existing_oidc`
object with issuer, JWKS URL, authorization and token endpoints, web/mobile
client IDs, audience, scopes, and token mode. No users, passwords, client
secrets, or membership records are created for this mode. Register the exported
web callback (`https://<web CloudFront hostname>/auth/callback`) and mobile
callback (`greenguard://auth/callback`) at the existing provider.

The existing provider must support discovery at the issuer, Authorization Code
with PKCE, and **JWT access tokens** accepted by the BFF for the configured
issuer/JWKS/audience. Clients send access tokens, with no ID-token fallback.
`token_mode` must be `audience`, with a nonempty audience. Dashboard currently
requests exactly `openid profile email offline_access` and discovers endpoints
from the issuer; its configuration has no custom scopes or explicit discovery
endpoint overrides. The external scopes input must match that set, and the
provided authorization/token endpoints must agree with issuer discovery. A
provider incompatible with these requirements needs a separately reviewed
client change; Terraform cannot adapt it silently.

`identity_mode = "cognito"` explicitly opts into a disposable Cognito pool and
public code-flow clients. Cognito uses `cognito-access`, a client-ID allowlist,
and `openid profile email`; no legacy audience is inherited. Cognito outputs
are null in existing OIDC mode. Four `moved` blocks retain existing unindexed
Cognito resource addresses when Cognito is explicitly retained. Switching a
previously applied Cognito cell to existing OIDC proposes deleting those
Terraform-owned identity resources; review state and plan before any apply.

Shared locals for GitOps integration are `oidc_public`, `oidc_verifier_env`,
`oidc_dashboard_values`, and `oidc_mobile_config`. GitOps must consume those
instead of unindexed Cognito resources and forced Cognito env values. Tenant
membership remains authoritative in the control plane; issuer accounts alone
never grant tenant access. Public endpoints are validated as deployed HTTPS
URLs, not credentials or placeholders.

Offline static proof: `ruby infra/terraform/disposable/identity-contract-test.rb`
checks default selection, all conditional Cognito resources, guarded outputs,
callback/access-token compatibility, and public/verifier configuration. It does
not claim provider discovery or AWS execution success.

Recorded [static contract evidence](../../../evidence/tenant-sharding/identity-contract/static-contract-tests.log): six tests and 97 assertions passed. Terraform 1.16.4 formatted `identity.tf`; isolated [Terraform validation](../../../evidence/tenant-sharding/identity-contract/terraform-validate.log) passed with pinned AWS 6.60.0 and Helm 3.3.0 after adding the signed Linux ARM64 checksum to the scratch lockfile only. The repository lockfile is unchanged. This validates the identity module with fixture CloudFront resources; full GitOps integration requires full-module validation. No plan, apply, or AWS APIs were used.
