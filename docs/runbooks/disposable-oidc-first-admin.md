# Disposable OIDC first-admin enrollment

The selected OIDC provider authenticates people. GreenGuard's tenant control
plane separately owns tenant membership; a valid provider account alone never
grants tenant data access. This procedure enrolls the verified token holder as
the first admin of a new disposable-cell tenant through the durable tenant
bootstrap workflow.

## Prerequisites

- Deploy and migrate the disposable control-plane database and services.
- If using `identity_mode = "managed-dex"`, first provide an explicit owner
  account through the ephemeral Terraform secret input. Set
  `secret_names` to include `greenguard-dex-config`, and provide
  `runtime_secret_values["greenguard-dex-config"]` with exactly
  `DEX_FIRST_ADMIN_EMAIL` and `DEX_FIRST_ADMIN_PASSWORD_HASH` (a bcrypt hash,
  never a plaintext password). The central `greenguard-rds-bootstrap` payload
  must also include a distinct strong `DEX_DB_PASSWORD`. These values are
  ephemeral, written to the disposable Secrets Manager containers, and synced
  into namespace `greenguard`; the local Dex `.env`, fixture users and signing
  keys are not copied. Terraform fails closed when either input is missing or
  malformed.
- Managed Dex's issuer is the current cell's API CloudFront HTTPS hostname at
  `/dex`, which differs from the local `127.0.0.1` issuer. Destroy/recreate
  changes that issuer, so the owner must re-enroll. Managed Dex currently
  creates only the explicitly supplied first login; it does not import demo
  accounts or grant any tenant membership.
- `DEX_FIRST_ADMIN_USER_ID` is an internal Dex static-password record UUID,
  not the OIDC token `sub` and not a GreenGuard membership subject. With Dex's
  `local` password connector the verified token subject is connector-qualified.
  Enrollment and acceptance must take `sub` from the signature-verified live
  access token; never copy the configured UUID into tenant membership.
- Configure Terraform with the provider's exact HTTPS issuer, JWKS URL, API
  audience and public client IDs, unless `identity_mode = "managed-dex"` is
  selected, in which case Terraform derives them from that cell's CloudFront
  endpoints. Web and mobile use Authorization Code + PKCE with S256.
- Register the web callback from `oidc_public_configuration.web_callback` and
  `greenguard://auth/callback` at the provider.
- Sign in as the intended human user and obtain a short-lived **access token**;
  do not use an ID token.
- Run from an operator host whose AWS identity can access the selected EKS API.
  The host does not need database access or permission to read runtime Secrets.

## Run enrollment

Write the token to an owner-only file through a secure mechanism. Never place it
in a command argument, shell history, Terraform variable, or repository file.

```sh
umask 077
chmod 600 /secure/operator/path/access-token.txt
cd infra/terraform/disposable
terraform output -json disposable_cell_identity
terraform output -json oidc_public_configuration
./enroll-first-admin.sh --enroll 00000000-0000-4000-8000-000000000002 --token-file /secure/operator/path/access-token.txt --confirm '00000000-0000-4000-8000-000000000002:https://your-exact-issuer/'
```

Use a newly generated tenant UUID and the exact issuer from Terraform output.
The helper rejects production, checks the current AWS account against the
Terraform cell, selects the exact EKS cluster and checks its ARN, API endpoint,
and CA. It waits for a Ready tenant-control-plane pod, then execs the CLI in
that pod. The token bytes travel on stdin only; Terraform state, process
arguments, environment, logs, and helper output do not contain the token.

Inside the pod the CLI uses the normal mounted `CONTROL_DATABASE_URL` and RDS
CA. It verifies token signature, exact issuer, audience or configured Cognito
client binding, algorithm, expiry, and subject. It queues the durable tenant
bootstrap. Owner-specific bootstrap workers must establish their ownership
receipts before activation. The CLI polls the authoritative membership lookup
with a bounded timeout and exits successfully only when the same verified
`(issuer, sub)` has an active admin membership for the requested tenant.
Timeouts, tenant mismatches, and non-admin membership fail closed.

## Acceptance boundary

The offline unit and command-stub tests prove operator guards, token transport
boundaries, and wait/read-back behavior. They do not prove a live provider,
AWS/EKS connectivity, all bootstrap workers completing, or web/iPhone access.
After running in the disposable cell, verify the resulting active tenant with
the disposable live acceptance procedure and exercise web/mobile login. Never
use this workflow against production. Existing tenants use the invitation and
revocation workflows.
