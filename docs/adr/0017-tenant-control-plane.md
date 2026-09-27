# ADR-0017: First-party tenant control plane and membership revocation

Status: Accepted — 2026-09-25. Owner: Stage 09a.

## Context

ADR-0014 verifies an IdP token before mapping its issuer and subject to a GreenGuard
tenant. Its JSON membership file is a local fixture. The platform target exceeds the
organization limits of a single hosted IdP tenant, and a removed user's still-valid
access token must stop authorizing GreenGuard requests within a bounded interval.

## Decision

The IdP proves identity. `tenant-control-plane` owns organizations, invitations and
memberships in `greenguard_control`; it is the only writer. A deterministic UUID from
`issuer|subject` identifies a person without putting raw IdP subjects on the event bus.
One identity may have memberships in several tenants, but the current token has no
tenant selector: simultaneous active memberships fail closed as ambiguous.

Human membership roles are `viewer`, `operator` and `admin`; `device` is reserved for
credentials. A membership is `active` or `revoked`, never deleted. Each transition
increments its bigint version. Revocation records `revoked_at` and `revoked_by`;
reactivation clears both. Commands lock the organization row first, then apply an
expected membership version. This serializes the last-admin check and makes stale
`If-Match` requests fail. A command writes the changed row, an append-only audit row,
an idempotency receipt and `membership.changed` outbox row in one PostgreSQL
transaction. CDC publishes only committed outbox rows.

Every tenant table has forced RLS and an application tenant filter. The runtime role
has no DELETE privilege and cannot UPDATE audit, receipt or outbox rows. `identities`
is the documented tenantless exception because one identity may join several tenants.
The internal lookup is constrained by a transaction-local identity ID; it returns the
sole active membership, the sole revoked membership, or no result, and rejects two
active memberships.

Verifiers retain a positive answer for at most 30 seconds and a negative answer for
at most 5 seconds. After lookup failure, a last good answer expires at 5 minutes.
`membership.changed` carries the tenant, identity and monotonic membership version.
Consumers invalidate their local cache immediately and store a monotonic version floor
in Redis Cluster using an atomic Lua comparison of decimal strings. A delayed lookup
older than that floor is rejected. The floor expires after 10 minutes, beyond the
maximum stale window; later lookups remain bounded by the normal 30-second TTL.
Redis or control-plane uncertainty cannot extend access beyond the 5-minute bound.

Existing device-service tenant rows become a projection from `tenant.created`; direct
tenant writes must be cut over before declaring the ownership migration complete.

## Consequences

The control plane must be seeded with the local Dex fixture before switching verifiers
from file mode. Each verifier service must instantiate the control-plane adapter, pass
the Redis version store and consume `membership.changed`. The platform-wide revocation
gate requires BFF, Read API and saga API live checks after that wiring. Auth0
Organizations are not used as GreenGuard tenants; enterprise IdP connections are a
separate Stage 09g concern.
