# Tenant control plane

Stage 09a implementation: first-party organizations, identities, invitations and
versioned memberships. See [ADR-0017](../../docs/adr/0017-tenant-control-plane.md).
The service owns `greenguard_control`; `control_app` is a non-owner runtime role.

## Tenant database placement

`organizations.shard_id` and `routing_epoch` are authoritative. The registry seeds
stable IDs `s1` through `s4`; provisioning and local database ownership fences are
separate requirements before those targets accept tenant traffic. Existing tenants
retain `s1` when the placement migration runs.
The legacy bundle `s1` remains active; `s2`–`s4` start offline. Ring version 1
contains only `s1`. After proving primary/replica, migrations, ownership import and
CDC readiness, bootstrap atomically activates the new registry entries, inserts
immutable ring version 2 containing all four, and changes the onboarding policy to
version 2 in the same control-plane transaction. This prevents partial bootstrap
from assigning tenants to an unprovisioned bundle.
For a fresh disposable cell, the trusted migration connection sets
`greenguard.bootstrap_mode=greenfield` (PostgreSQL startup `options=-c greenguard.bootstrap_mode=greenfield`).
That seeds all four offline and the first ring with all four; guarded bootstrap
activates them atomically only after proving readiness. Unknown modes fail the
migration. Onboarding rejects a policy containing any inactive or unknown member.

New organizations use a SHA-256 consistent hash ring with 128 virtual positions per
shard to suggest their initial placement. The chosen shard and immutable ring
version are persisted in the organization transaction. Ring configuration changes
affect new organizations only. A trusted onboarding caller may explicitly override
the shard; the public create endpoint rejects additional routing fields. Operational
requests always resolve the persisted placement and never rehash the tenant ID.

`GET /v1/organizations/:tenantId/placement` checks the verified identity's active
membership in that tenant. `GET /v1/internal/placements/:tenantId` requires the
service lookup credential and must remain private to trusted services; its caller
derives the tenant from a verified principal, device binding or validated event.
Neither endpoint accepts shard/epoch hints. Responses contain decimal-string
epochs, the registry's `shardIncarnation` UUID, and a one-second expiry with
`Cache-Control: no-store`. Bootstrap must initialize each bundle's database-local
owner with that same registry UUID. Replacement/restore requires the privileged
registry operator to mark the shard offline, rotate incarnation with a CAS on
the old incarnation/configuration version, and advance the configuration version.
The database rejects incarnation changes while online or without that advance.
The operator verifies the replacement owners before marking the shard active;
old cached routes fail the database ownership tuple check.
The shared placement
resolver rejects malformed, mismatched or expired leases and fails closed on an
authority outage after expiry. Its `fresh` option bypasses a cached lease at
admission boundaries. Concurrent loads share one lookup; invalidation cancels their
ability to admit the response. HTTP credentials require HTTPS or loopback by
default; `meshMtls: true` is an explicit deployment assertion that Istio STRICT
mTLS protects the pod-to-pod hop.

The resolver's local regression guard expires with its route lease and is bounded
by the cache capacity. It flags a regressing fresh response while that guard is
valid as `placement_authority_invariant_violation`. Expiry, eviction and process
replacement do not change tenant ownership: every cache miss consults the
control-plane primary, and the persisted epoch plus database transaction ownership
fence remain authoritative across processes. `expectedEpoch` rejects stale caller
leases, and cache/read admission must compare leases with persisted placement.

Placement mutations are domain functions for the trusted migration controller;
there is no public move endpoint. Every mutation locks the organization row before
the operation row, while a partial unique index enforces one live move per tenant.
`preparePlacementMove` creates a durable `preparing` operation while the tenant
remains active for bulk baseline copy. `beginPlacementMove` then enters `quiescing`
for the short final pause and drain. The controller verifies and records immutable
`source_fenced`, `target_prepared`, and `copy_verified` receipts before
`compareAndSetPlacement` atomically changes the shard and advances the epoch once.
Each required receipt must carry `verified: true`. The control-plane DB trigger
also checks the switched operation and positive markers before changing ownership;
runtime epoch bumps and reactivation require the corresponding durable operation.
The new route remains `activating` until a positive `target_activated` receipt and
`finishPlacementMove(..., "completed")`. A pre-switch abort requires positive
`targets_unactivated` and `source_reactivated` receipts and advances the epoch.
Retries replay the durable operation; a different request with the same operation
ID fails. Receipt storage is a controller interface: the later migration layer
must verify actual database fence/activation receipts before recording them.

This control-plane slice does not by itself fence operational databases or migrate
tenant data. Operational transactions must separately validate the database-local
owner and epoch; a placement cache lease is not permission to bypass that fence.

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
