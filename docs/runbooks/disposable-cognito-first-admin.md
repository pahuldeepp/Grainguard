# Disposable Cognito first-admin enrollment

GreenGuard keeps tenant membership in the tenant control plane. Cognito authenticates a person; creating a Cognito user by itself grants no GreenGuard data access. This operator command bootstraps only the first admin of a **new** tenant. Existing tenants add people through GreenGuard's authenticated invitation flow.

1. Deploy the disposable Cognito user pool and tenant control-plane database/migrations. Retrieve `oidc_public_configuration.issuer` and the user-pool ID from Terraform output. The pool is invitation-only; invite the intended human with `aws cognito-idp admin-create-user` outside Terraform, and have them complete the password setup and email verification. Never put a password or invitation in Terraform variables or state.
2. After the invitee completes their Cognito password challenge and email verification, run the account-guarded verifier from `infra/terraform/disposable`:

```sh
./enroll-first-admin.sh --verify-only owner@your-domain.example
```

It reads the exact pool, issuer, region, and AWS account from this Terraform state, calls `admin-get-user`, and refuses disabled, unconfirmed, or unverified accounts. It never prints credentials. Replace the example email with the invited person's real address.

3. Choose a fresh lower-case UUID for the tenant. On an authorized, private operator host with `CONTROL_DIRECT_URL` pointing at the migrated control-plane database, build the tenant control plane and run:

```sh
npm run build -w @greenguard/tenant-control-plane
# Load CONTROL_DIRECT_URL from the approved operator secret workflow.
(cd infra/terraform/disposable && ./enroll-first-admin.sh --enroll owner@your-domain.example 00000000-0000-4000-8000-000000000002)
```

Use the actual email and new tenant UUID; the values above are placeholders. The helper supplies the verified Cognito `sub` and Terraform issuer to the existing enrollment CLI. The command creates the organization, active admin membership, audit row, and outbox events in one database transaction. Repeating the same command returns `existing`; another subject or role for that tenant fails. Do not expose the direct database URL to the web or mobile clients, and clear it from the operator shell after enrollment.

4. Sign in on the web or iPhone with Cognito Authorization Code + PKCE, and verify the BFF resolves the exact `issuer|sub` to this tenant. Test an unregistered Cognito account: it must be denied tenant data. Test an invitation and revocation through the control-plane API.

This command does not invite users, verify their email, publish images, deploy the database, or prove the live sign-in flow. Those steps require the AWS deployment and acceptance run. Dex remains the local/test issuer.
