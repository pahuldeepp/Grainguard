# Tenant ownership admission and fence

Every operational owner database has a local `greenguard_internal.tenant_ownership`
row for each tenant assigned to that shard. The row contains the stable shard ID,
shard incarnation, placement epoch, and state. New tenant writes require an active
row that exactly matches the route resolved from central placement authority.

The checked-in owner migrations install the same database contract in device,
alerts, risk, telemetry ingest, projections, jobs, hardware, saga, and notification
owner databases. Existing databases are **not** assigned to a shard by migration.
They remain closed until a trusted placement export is imported. Control-plane,
billing, and shared non-PostgreSQL stores are outside this local PostgreSQL fence.

Every migration installs `greenguard_internal.assert_tenant_fences_installed()`.
Deployment bootstrap must call this audit after **all** owner migrations on every
owner database. It fails if any current public table or partition with a
`tenant_id` column is missing either the row fence or TRUNCATE fence. PostgreSQL
clones row triggers to new partitions, but does not clone statement-level
TRUNCATE triggers. The migration therefore revokes TRUNCATE from the known
runtime roles and from their current defaults, and keeps PUBLIC defaults closed;
runtime roles cannot directly truncate a future leaf even before its trigger is
installed. A trusted partition maintainer must still install the statement fence
on each new leaf and run the audit. Task 8 must verify both that audit and a
runtime-role TRUNCATE denial on a newly-created leaf. Automatic installation by
the partition maintainer remains pending.

## Runtime transaction contract

Go writers use `packages/go-common.WithTenantPlacement` with a route returned by
the authenticated placement client: tenant ID, shard ID, shard incarnation,
decimal placement epoch, active state, and future expiry. It starts a transaction, sets
transaction-local context, and calls `admit_tenant_placement`, which locks the
local row `FOR SHARE` until the transaction ends. An ownership update/fence must
take the conflicting row lock, so it cannot overtake an admitted transaction.
Row triggers repeat the comparison before each INSERT/UPDATE/DELETE on tables
with `tenant_id`; they also reject tenant ID changes. TRUNCATE has an unconditional
statement trigger and is forbidden on these tables. Existing RLS and application
tenant filters remain required.

This helper does not yet replace every service's old tenant-only transaction
entrypoint. The ownership migration and Go helper establish the shared contract;
Task 5 must route each synchronous writer and asynchronous consumer through it.
Until then, the database triggers still deny writes without matching local route
settings, so those old write paths fail closed once the ownership migrations are
installed.

PostgreSQL custom `app.*` settings are caller-settable. This contract assumes
runtime code and its authenticated placement client are trusted and that each
process only uses the route returned for its tenant. A stale worker holding an
older route cannot advance its own epoch: only the trusted placement authority
can return the newer route, and the worker role cannot read or modify the local
ownership table. A compromised service credential or arbitrary SQL execution
could set a guessed newer GUC, however; this fence is not a cryptographic
capability boundary against a compromised SQL client. That stronger threat model
would require short-lived signed admission capabilities verified inside each
database and key distribution/rotation, which is not part of this slice.

## Trusted placement import contract

Database initialization creates the dedicated **NOLOGIN** role
`tenant_ownership_bootstrap` before owner migrations. The current init SQL grants
SET-role membership to the bootstrap administrator; a separate authenticated
import principal is still required before deployment. Owner migrations fail if
the role is absent and grant it EXECUTE on the seed function. Do not grant
membership or function execution to application, projector, CDC, or read roles.
Runtime roles have no direct access to the ownership table.

An authenticated exporter obtains an explicit placement snapshot from central
authority. For every owner database, bootstrap calls:

```sql
SELECT greenguard_internal.seed_tenant_ownership(
  $snapshot::jsonb,
  $local_shard_id::text,
  $local_shard_incarnation::uuid,
  $authoritative_count_for_shard_and_incarnation::integer
);
```

The snapshot is an array of records with `tenantId`, `shardId`,
`shardIncarnation`, `placementEpoch` (integer), and `state: "active"`. Only
records matching the destination database's shard and incarnation are installed.
The procedure validates the local assignment count before changing any fence,
consumes the full snapshot, and is idempotent. Before importing, it
fences any existing non-fenced row on the local stable shard that is absent or no
longer an exact active `{tenant, shard, incarnation, epoch}` match. It inserts
missing exact assignments, but never changes a conflicting row's shard,
incarnation, or epoch. Its return value is the number of exact local active
assignments present after import. The function checks that count against the
trusted expected count inside its transaction, so an incomplete snapshot rolls
back without fencing existing rows; bootstrap independently compares the return
value and blocks application startup on any mismatch. Same-tenant epoch/incarnation changes remain fenced or
unresolved until the move/restore procedure handles them. This startup importer
is not the live tenant-move mechanism. Never synthesize placement from a hash,
tenant ID, environment default, or whichever database is reachable.

The checked-in code does not yet implement central placement export, snapshot
authentication/transport, a separate import principal, or invoking this import
before services start. Those remain explicit deployment wiring blockers. The
seed procedure is an interface, not evidence that existing tenant databases are
already initialized.

## Limits and next integration

The migrations attach triggers to tenant-ID columns present when each migration
runs. Every later migration that adds a tenant-owned table must install the same
row and TRUNCATE fences. This deliverable does not yet migrate all TS/Python/Go
service callsites, add durable trusted drain/copy capabilities, or implement the
move-side fence/activation procedures. Read admission/freshness remains a separate
read-path integration. Tests for those behaviors are required before Stage 13
shard migration acceptance.
