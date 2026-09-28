# Disposable OIDC first-admin enrollment

The selected OIDC provider authenticates people. GreenGuard's tenant control
plane separately owns tenant membership. A valid provider account alone never
grants GreenGuard data access. This operator workflow binds the holder of a
verified access token to the first admin of a **new** tenant; existing tenants
must use the authenticated invitation workflow.

## Prerequisites

- Deploy and migrate the disposable control-plane database and services.
- Configure Terraform with the existing provider's exact HTTPS issuer, JWKS
  URL, API audience and public client IDs. The identity contract requires JWT
  access tokens, Authorization Code + PKCE for web/mobile, and the scopes
  `openid profile email offline_access` for the dashboard.
- Register the deployed web callback from `oidc_public_configuration.web_callback`
  and `greenguard://auth/callback` at the provider. The web callback uses the
  AWS-owned CloudFront HTTPS hostname; there is no custom domain requirement.
- Obtain a short-lived access token by signing into GreenGuard with the intended
  human account. It must be signed by the configured issuer and have the exact
  configured API audience. Do not use an ID token.
- Run the helper from an authorized private operator host with permission to
  read the exact Terraform-owned `tenant-control-plane-config` secret in the
  selected disposable AWS account. The helper extracts only its TLS-verified
  control database URL into the child process environment; it never prints or
  places the URL in command arguments. The database must be reachable over the
  private route.

## Enroll the first admin

Write the access token into a temporary file with owner-only permissions, for
example from a secret manager or a password manager's secure file export. Do
not put the token in a command argument, Terraform variable, shell history, or
repository file. Confirm the Terraform workspace is the disposable cell, then:

```sh
umask 077
chmod 600 /secure/operator/path/access-token.txt
cd infra/terraform/disposable
terraform output -json disposable_cell_identity
terraform output -json oidc_public_configuration
./enroll-first-admin.sh --enroll 00000000-0000-4000-8000-000000000002 --token-file /secure/operator/path/access-token.txt --confirm '00000000-0000-4000-8000-000000000002:https://your-exact-issuer/'
```

Replace the UUID with a newly generated tenant ID. The helper checks the
Terraform cell is not production, requires the currently authenticated AWS
account to equal the account in Terraform state, and requires a token file
owned by the operator with mode `0600` or stricter. It reads issuer, JWKS,
audience/token mode and client allowlist from Terraform outputs, then passes
the TLS-verified database URL from the exact cell-scoped Secrets Manager ARN
and the token on standard input to a verifier using GreenGuard's same JWT rules:
signature, exact issuer, audience or client binding, algorithm, and expiration.
The subject is taken only from the verified token. It supports provider-defined
non-UUID `sub` values. No token or identity is logged or stored in Terraform.

An explicit `TENANT_ID:ISSUER` confirmation, copied from the Terraform output,
is required and must match exactly. Enrollment creates
the organization, active admin membership, audit row and outbox event in the
existing database transaction. Repeating the exact identity for that tenant
is idempotent; trying to seed an existing tenant with a different identity
fails. The token holder is trusted by the operator as the intended first
admin; this command does not implement a self-service invitation workflow.

After enrollment, sign in on web/iPhone and verify that the BFF resolves the
exact `(issuer, sub)` pair to the new tenant. A valid but unregistered identity
must be denied tenant data. Exercise the normal invitation and revocation
flows for subsequent users.

## Limits of offline proof

The offline tests verify signed test tokens and reject wrong issuer, wrong
audience and expired-token cases, plus the account/environment/file-permission
guards. They do not prove the real provider's discovery/JWKS behavior, a live
user's membership, or the deployed database route. Those require the actual
disposable cell and real-user web/iPhone acceptance. Never point this workflow
at production.
