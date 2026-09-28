# Tenant control plane

## Greenfield tenant ownership bootstrap status

The control plane can persist an initial shard placement, but tenant creation is
not yet a complete four-shard bootstrap workflow. No deployed event consumer or
request path currently provisions `greenguard_internal.tenant_ownership` in all
nine owner databases before making the placement available. The existing
`seed_tenant_ownership` database function is a full-shard snapshot importer; it
can fence local rows missing from its input and must not be used as a
single-tenant seed operation.

`src/tenant-bootstrap/preflight.ts` defines an offline contract for the missing
provisioner. It requires exactly one adapter per sharded owner, direct readiness
proof from all owners on the selected shard, and matching read-back proofs for
all nine owners before routing activation. The module is validation-only: it
does not contact databases, write ownership rows, or activate tenants. Its
plain-object assertions are forgeable and its migration hashes are not compared
against an expected per-owner manifest; they are useful only for testing input
shape and must never authorize activation. Until authenticated probes, an
expected migration manifest, and a durable worker implement and deploy the full
protocol, tenant bootstrap across shards remains blocked and must fail closed.

Stage 09a implementation: first-party organizations, identities, invitations and
versioned memberships. See [ADR-0017](../../docs/adr/0017-tenant-control-plane.md).
The service owns `greenguard_control`; `control_app` is a non-owner runtime role.

## Tenant database placement

`organizations.shard_id` and `routing_epoch` are authoritative. The registry seeds
stable IDs `s1` through `s4`; provisioning and local database ownership fences are
separate requirements before those targets accept tenant traffic. Existing tenants
retain `s1` when the placement migration runs.
The legacy bundle `s1` remains active; `s2`–`s4` start offline. Ring version 1
contains only `s1`. The required guarded bootstrap transition is not implemented:
there is no production command that proves primary/replica, migrations, ownership
import, and CDC readiness, then atomically activates the registry entries, inserts
immutable ring version 2 containing all four, and changes the onboarding policy to
version 2. Do not treat the registry seeds as a completed four-shard bootstrap.
For a fresh disposable cell, the trusted migration connection sets
`greenguard.bootstrap_mode=greenfield` (PostgreSQL startup `options=-c greenguard.bootstrap_mode=greenfield`).
That seeds all four offline and the first ring with all four. A guarded activation
step is still required before onboarding can work in this mode; the current
onboarding path rejects a policy containing any inactive or unknown member.
Unknown bootstrap modes fail the migration.

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

Placement mutations are domain functions; there is no public move endpoint or
deployed trusted migration controller. Every mutation locks the organization row
before the operation row, while a partial unique index enforces one live move per
tenant. `preparePlacementMove` creates a durable `preparing` operation while the
tenant remains active for bulk baseline copy. `beginPlacementMove` enters
`quiescing` for the short final pause and drain. The domain functions validate
operation-bound receipt fields and owner names, but those checks only validate JSON
shape and identity. They do not establish that an owner database produced the
receipt. The SQL predicate in `20260928160000_structured_move_evidence` likewise
checks the top-level receipt envelope, not the owner roster or independent owner
database provenance. `control_app` currently has permission to insert a move and
update its state, result epoch, and receipts. Therefore the current database
permissions do not make caller-supplied receipts trustworthy. The append-only
trigger prevents later edits/removal of existing receipt entries; it does not
authenticate the first write. No production tenant cutover is safe to enable on
these checks alone.

The migration-owner interfaces are incomplete: Risk, Telemetry, and Inventory have
owner-local procedures that create durable operation receipts, but their TypeScript
adapters validate returned JSON in the application and do not provide a
cryptographic/database-verifiable attestation to the control-plane database.
Projection is a hard preflight blocker because history partitions, shared Kafka
offsets, CDC outbox, inbox/completion state, and watermarks lack a coordinated
copy/replay receipt. Alerts only has a CDC-history preflight; Jobs and Notifications
only have separate drain checks, not copy/activate receipt APIs. Saga and Hardware
have no complete move adapters. Thus there is no source that can currently furnish
an authentic receipt set for all nine owners.

Before enabling cutover, add a private mover runtime with a separate database
identity and an owner contract for every roster member. Each owner must expose a
restricted operation that independently checks its committed fence/copy/activation
state and returns an authenticated receipt bound to tenant, operation, phase,
source/target shard IDs and incarnations, source/target epochs, and copy lineage.
The control-plane commit/cutover function must verify those authentic receipts,
require exactly the nine-owner inventory, check read-lease drain and replica
freshness, and perform the placement CAS atomically. `control_app` must not be able
to write receipts or advance placement; deployment must provision the separate
mover credential only to that private runtime. Until that interface, the nine
owner adapters, and negative privilege tests exist, migration must fail closed.
Synthetic JSON fixtures prove only validation behavior, not migration acceptance.

`src/tenant-move/move-coordinator.ts` is a preflight skeleton for that private
mover, not an enabled migration controller. Its adapter roster requires every
owner to implement quiesce/drain, source fencing, copy verification, target
preparation/activation, replica-freshness verification, and recovery before an
adapter roster is accepted. The current registered owner set (Inventory, Risk,
Telemetry) is intentionally rejected. This module exposes no execution callback
or cutover path. The gate does not attest adapter provenance or manufacture
receipts; it must be paired with the separately authenticated owner receipt
contract above before cutover code can be implemented. Tests cover missing
owners, incomplete safety boundaries, and duplicate registrations.

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
