# Tenant control plane

Stage 09a implementation: first-party organizations, identities, invitations and
versioned memberships. See [ADR-0017](../../docs/adr/0017-tenant-control-plane.md).
The service owns `greenguard_control`; `control_app` is a non-owner runtime role.

Run `npm run migrate -w @greenguard/tenant-control-plane` with
`CONTROL_MIGRATION_URL` set. `npm test -w @greenguard/tenant-control-plane` runs
live PostgreSQL tests and needs `CONTROL_DATABASE_URL`, `CONTROL_DIRECT_URL` and
`POSTGRES_ADMIN_URL` from the local `.env`. The migration creates forced RLS on all
tenant tables. Commands set `app.tenant_id` transaction-locally and take the
organization row lock before editing memberships. Membership edits require an
expected version and write audit and outbox in the same transaction.

The internal verifier lookup requires `CONTROL_LOOKUP_TOKEN`. It returns one active
membership or a revoked membership with its version. A verified identity with active
memberships in two tenants is rejected as ambiguous. The file seed in `infra/oidc/`
is a local Dex fixture; `npm run seed -w @greenguard/tenant-control-plane` loads it
idempotently after migration.

## Stage 09b machine credentials

Set `CONTROL_API_KEY_PEPPER` (at least 32 bytes from a secret store) to mount the
credential routes. Set all of `CONTROL_M2M_ISSUER`, `CONTROL_M2M_AUDIENCE`, and
`CONTROL_M2M_JWKS_URL` to validate enterprise client-credentials tokens. The
configured issuer must issue RS256 access tokens with a client-credentials grant
marker and lifetime at most 15 minutes. An active admin creates API keys or
registers an OAuth client under `/v1/organizations/:tenantId/credentials`.
Key plaintext is returned once. `GET` lists only metadata, including last use;
revocation and rotation write one transactional outbox event each. Internal
verification routes require `CONTROL_LOOKUP_TOKEN` and return the normalized
service context. See [ADR-0018](../../docs/adr/0018-machine-authentication.md).
