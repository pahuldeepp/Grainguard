# Projection builder — read projections and Stage 05b replay

Consumes `greenguard.inventory.device.v1` and `greenguard.telemetry.recorded.v1`
with group `projection-builder` and owns `greenguard_read`. It also has versioned
replay, schema-aware writers with fenced leases, and canonical promotion checks
through `CanonicalPromotionVerifier` and `PromoteReadViews`. The disposable
cutover test passes; no production swap command is enabled. Facility projections,
Cassandra/search consumers, and notification delivery remain separate work. See
[Stage 05b evidence](../../evidence/STAGE_05B_VALIDATION.md).

## Run and verify

After the owner provisions the local stack with `make bootstrap` and `make db-up`,
`make projection-migrate` uses `PROJECTION_MIGRATION_URL` (direct PostgreSQL,
`projection_migrator`). `make db-migrate` includes this migration. Start with
`KAFKA_BROKERS=127.0.0.1:19092 go run .` from this directory, exporting
`PROJECTION_DATABASE_URL` from the generated `.env` first. Runtime traffic uses
`projection_app` through PgBouncer with unnamed pgx statements.

```sh
GOFLAGS=-mod=mod GOPROXY=off go vet ./...
GOFLAGS=-mod=mod GOPROXY=off go test -race -cover ./...
```

Database tests need `PROJECTION_DIRECT_URL`, `PROJECTION_DATABASE_URL`,
`PROJECTION_MIGRATION_URL` and `POSTGRES_ADMIN_URL`. The migration test creates a
scratch database and applies the real migration twice. The other database tests
use random tenants in the migrated local database. They never delete existing
projection data. Missing environment variables produce explicit skips.

`EVENT_SCHEMA_DIR` defaults to `../../contracts/events`; the container includes
those unchanged schemas at `/contracts/events`. Four schemas compile at startup
with format assertions. Kafka records are plain JSON with all six canonical
headers checked against their envelope; unknown types, schema versions, header
collisions, bad keys, invalid UUIDs, bigint overflow and aggregate/payload identity
mismatches quarantine before acknowledging offsets. Quarantine keeps source
coordinates, a bounded 64 KiB raw sample, and a validated tenant purge header
(`unknown` if invalid). It contains sensitive operational data and is not a
customer read interface.

## Transaction and ordering rules

Each event uses one transaction: local tenant context, inbox, stream locks, view
changes, notification, checkpoint, commit. JSONB equality makes reordered JSON
properties/whitespace a semantic duplicate; changed content for an existing event
ID is `event_id_conflict`. SQLSTATE classes 22/23 become `db_rejected`. RLS denial
(`42501`) and unavailable history partitions (`55000`) remain hard errors with
uncommitted offsets, so tenant bugs and missed maintenance cannot be hidden by
quarantine. Transient
connection/serialization/deadlock/lock errors retry five times with exponential
backoff, within a 20-second processing deadline. Exhaustion stops the worker with
the offset uncommitted. Quarantine publishing and offset commits also have bounded
retries. A successful database commit followed by an offset failure is safe to
redeliver. Ambiguous commits resolve through the same inbox.

One outstanding record across all partitions preserves the commit frontier and
blocks rebalance during work. `NoResetOffset` makes expired committed offsets a
fatal error rather than skipping retained-history gaps. New groups start at the
log beginning. Recovery requires retained source and a deliberate operational
replay/reset; no unlimited recovery horizon is promised.

Concurrency choices and grants are beside the forward-only SQL migration:

- Inbox/notifications use durable unique identities. History uses a daily partition key. Runtime grants have no DELETE
  or identity-column UPDATE privileges.
- All device work locks the inventory stream anchor; telemetry then locks its
  telemetry stream, gap ranges, and latest row. This serializes inventory enrichment with
  history insertion. Lock timeout is two seconds.
- Telemetry tracks open version ranges, splitting/shrinking them on late arrival.
  Closed ranges remain stored without DELETE. Latest selects the greatest
  `(observed_at, stream_version)`; hot-window readings remain in history.
- Partial device deltas wait in the inbox until their contiguous predecessors
  arrive, then fold in version order. Device views use version guards. A
  max-version-only update would lose binding or status changes. Replayed stale
  identities are no-ops; a different identity reusing an inventory version is
  rejected by the unique version index.
- Inventory arriving after telemetry marks enrichment applied without changing
  the event-carried historical site/bin metadata.

## Freshness and observability

### Committed projection watermarks (tenant sharding Task 6)

Migration **000019** adds tenant-scoped, forced-RLS `projection_watermarks` and
`projection_event_completions` in every projection schema. Stable invoker-security
views `read.projection_watermarks` and `read.projection_event_completions` follow
the active data schema during promotion. Each watermark is identified by durable
`(tenant_id, shard_incarnation, placement_epoch)`; compare its sequence only within
that identity. Epoch and sequence cross JSON boundaries as exact decimal strings.

`WithTenantSchema` admits workers through the local durable active
`greenguard_internal.tenant_ownership` row, locked `FOR SHARE`, and sets placement
context from that row. Missing, quiescing or fenced ownership denies traffic;
no process default or event field supplies an incarnation. This proves local
ownership admission. Control-plane routing, authority quiesce and bounded read
leases remain responsibilities of the routing/worker-fencing tasks.

An owner-controlled bootstrap/import must seed active customer ownership before
traffic. Its trigger initializes an explicit sequence **0** in every projection
schema without resetting existing sequences. Provisioning initializes new schemas
from the same durable rows. Before replay, writer leases, heartbeat writes or
promotion, `tenant_ownership_bootstrap` must seed the reserved infrastructure
tenant using `greenguard_internal.seed_projection_infrastructure_ownership(shard,
incarnation,epoch)` with the trusted database bootstrap identity. Missing bootstrap
fails closed. Infrastructure promotion notifications have their own sequence;
they do not certify any customer's projection.
Customer snapshot import rejects caller-supplied reserved tenants and preserves
the separately bootstrapped local infrastructure row. A customer import whose
local identity conflicts with that durable bootstrap is rejected.

After inbox idempotency admission, `INSERT ... ON CONFLICT DO UPDATE` locks the
tenant/identity watermark row before stream/history locks. Each accepted event
transaction increments it once, writes effects and exact event completions,
then writes a notification/outbox and checkpoint in that transaction. Rollback
reveals none of these writes; duplicate delivery does not increment the sequence.
SQL notification/completion triggers require the matching watermark row to have
been written by the current transaction; they reject reuse of a committed row.
Apply 000019 before starting the new producer. The old producer rolls back its
effects after that migration because it cannot supply a transaction watermark.
This serializes independent aggregates for one tenant and requires tenant
throughput/load evidence before production acceptance.

Telemetry completion names the exact processed event, even when other versions
are missing. Inventory deltas remain unresolved until contiguous folding has
materialized them. The gap-fill transaction maps every newly folded inbox event
identity to its watermark. Maximum observed source versions never certify a
missing event. Historical notifications/inbox rows remain intact on upgrade;
the migration does not invent historical completion or watermark identities.
Existing retained notifications without identity cannot satisfy new read tokens.

New transactional notification payloads carry `shard_incarnation`,
`placement_epoch` and `projection_sequence`, with `source_version` retained
separately. Inactive shadows retain notifications locally. After promotion,
active versioned notifications enter the insert-only public CDC outbox with
validated source-schema provenance. Promotion locks the old and target tenant
watermarks, verifies exact old completion coverage, then rebases the target
sequence monotonically before switching all read views. The existing canonical
equality/frontier/writer-fencing proof is still required; numeric rebasing alone
does not authorize promotion.

The reader role can inspect local ownership through the scoped, read-only,
standby-compatible `greenguard_internal.projection_ownership_snapshot(tenant)`
function. It cannot invoke worker admission or mutate watermarks/completions.
These primitives alone do not implement source-write read-your-writes: a source
writer still needs to carry its exact event/version and resolve its completion
before a minimum projection read. Cassandra and OpenSearch need their own proof.

`Store.Freshness` returns last projection time, exact version strings, telemetry
and inventory gap flags, and binding-feed freshness, scoped through `WithTenant`.
It is a read seam for the future BFF, not an unauthenticated HTTP data endpoint.

Canonical binding-feed checkpoints advance only with increasing canonical/raw
offsets and nondecreasing source LSN/time. All six inventory partitions must be
present; age uses their oldest source time plus five seconds of clock allowance.
Future source time clamps to receipt time; replay does not refresh old evidence.
The freshness threshold is five minutes. This proves inventory feed freshness,
not a telemetry end-to-end completeness guarantee.

To satisfy the task's forced-RLS requirement for **every table**, infrastructure
barriers use the reserved tenant UUID `00000000-0000-4000-8000-000000000001` in
`projection_checkpoints`, through the same transaction-local tenant helper.
Canonical customer events with that tenant are rejected. Ordinary event
checkpoints use their actual tenant. This deliberately differs from the plan's
unscoped transport-metadata table; review the reserved namespace before deployment.
The requested role/group names also override the plan's `read_migrator` and
`greenguard.projection-builder.v1`. A BFF `read_query` role belongs to slice 05e.

`HTTP_ADDR` defaults to `127.0.0.1:8082`. `/healthz`, `/readyz` and `/metrics` expose
no tenant data. Readiness checks the worker, PostgreSQL and Kafka. Metrics include
retries, duplicates, collisions, quarantine, applied events, projection age,
source-feed age, latency histogram, and last-fetched per-topic/partition lag.
Lag is the last observed broker high watermark minus the acknowledged frontier;
it is not a continuously polled fleet backlog. Missing age evidence is `+Inf`.
Optional `OTEL_EXPORTER_OTLP_ENDPOINT` enables trace export; consumer spans
continue the stored `traceparent`. No tenant/device metric labels are emitted.

To add facility handling later, extend `eventTopics`, the schema map, subscribed
topics and effect dispatch with new migrations/tests. The current subscription
and schema allowlists intentionally accept only device and telemetry events.

## Hot history retention

[ADR-0011](../../docs/adr/0011-read-history-retention.md) is Proposed and records
this owner-requested read-side retention change. Forward-only migration **000002**
converts the existing heap to daily UTC `observed_at` partitions, preserving all
existing data before retiring the heap. Stop consumers for migration and budget
space for both copies. Apply with the existing migration command; 000001 is
unchanged. Initial conversion does not prune data.

| Configuration                   | Default | Accepted range                      |
| ------------------------------- | ------- | ----------------------------------- |
| `PROJECTION_HISTORY_HOT_WINDOW` | `24h`   | Go duration, `1h`–`2160h` (90 days) |
| `PROJECTION_HISTORY_AHEAD_DAYS` | `3`     | 1–30 days                           |

The consumer and maintenance command must receive the same hot-window value.
Future PostgreSQL/Cassandra query routing must use that same configuration and
cutoff (`now - hot window`), not the physical oldest retained partition. Cold data
belongs on the Cassandra route; the one-hour pruning safety margin provides overlap.
Increasing the window cannot restore already-pruned data without a backfill.

Build and run a **separate scheduled maintenance job** from this service directory:

```sh
go build -o /tmp/projection-maintain ./cmd/maintain
# Export PROJECTION_MIGRATION_URL and the two history settings in the job environment.
/tmp/projection-maintain
# Cron schedule (with the same environment loaded securely by the scheduler):
# */10 * * * * /tmp/projection-maintain
```

Run once before starting consumers and every ten minutes thereafter. The image
also includes `/projection-maintain` for a scheduled job with an entrypoint
override. Use a direct `projection_migrator` connection through
`PROJECTION_MIGRATION_URL`; never give migrator credentials to the consumer.
Set `PROJECTION_HISTORY_SCHEMA=read_vN` for each provisioned version and schedule
a separate maintenance job for that schema. An unset value maintains `public`.
Versioned writers fail closed if their own hot history partitions are absent.
Alert on job failures. Each pass creates missing daily partitions through UTC
today + ahead days (inclusive), retains the entire window plus a fixed **1h safety
margin**, and drops at most 32 partitions whose upper bounds are at/before that
cutoff. Maximum creation span is bounded by the 90-day window/30-day ahead limits;
the pass has a 30s context, 25s statement timeout and 2s lock timeout. Repeated or
concurrent runs are idempotent, serialized by transaction advisory lock `7240511`.

Writers take the shared advisory lock after inbox insertion and before inventory,
telemetry, gap and latest locks; maintenance takes its exclusive form before
computing bounds. Database statement time after that lock determines admission.
Out-of-window observations skip history even while an old partition still exists,
but are accepted for latest selection, version/gap tracking, inbox, notification
and checkpoint writes. Count only committed skips in
`projection_history_out_of_window_total`; duplicates and rollbacks do not count.
This counter is process-local and may undercount an ambiguous commit; it is not a
persisted audit total. Missing in-window partitions (including far-future input)
fail hard until operationally resolved; the consumer never creates partitions.

History has `PRIMARY KEY (tenant_id, observed_at, reading_id)` and the existing
`(tenant_id, device_id, observed_at DESC, stream_version DESC)` query index.
Inbox uniqueness handles replay idempotency and enforces telemetry version/reading
identity independently of history. `device_latest` now has a composite FK to inbox
consumer/tenant/event/device/reading identity; notifications have a composite FK to
inbox consumer/tenant/event identity. Neither depends on a retained history row.
Use the tenant-filtered inbox event for latest payloads after history expires.
Every partition has its own forced RLS policy and runtime SELECT/INSERT/enrichment
UPDATE grants. `projection_app` has no DELETE or maintenance execution privilege.

Only rebuildable **read-side** history may be pruned here. Write-side telemetry
PostgreSQL requires a durable **Cassandra confirmation watermark before deletion**;
that watermark/deletion protocol is not implemented in Stage 05. Inbox, gap and
notification retention remain separate future work.

## Bounded tenant replay (Stage 05b partial)

`node --env-file=.env scripts/projection-replay.mjs rebuild <tenant UUID>`
replays the selected tenant into an **independently provisioned shadow database**.
Run this command from the repository root. Set `PROJECTION_REPLAY_DATABASE_URL`
to the restricted `projection_app` connection for a database named
`greenguard_read_replay_<name>` (lowercase letters, digits and underscores; suffix
at most 40 characters). It refuses the live `greenguard_read` database and
superuser/BYPASSRLS connections. Provision the database with `projection_migrator`
as owner, then apply the existing `cmd/migrate` with `PROJECTION_MIGRATION_URL`
pointing **only to that shadow**. Run history maintenance for the same shadow and
hot-window settings before replay. No database is automatically created, dropped
or truncated by the operational command; the live inbox and live broker group
are never reset.

`status <tenant UUID>` reports captured retained-start/end and durable next offsets
per partition. Add `--dry-run` to `rebuild` to perform the same read-only inspection.
`compare <tenant UUID>` requires the shadow's durable replay checkpoints to equal
a captured Kafka frontier with offset zero still retained. It folds the selected
tenant's immutable shadow inbox events in pure Go and compares device fields,
latest selections, stream frontiers and open gaps with the shadow tables. It
reports `equal: false` and exits nonzero on a difference. This bounded check
does not validate the live projection, cold history, notification rows or a
future Kafka frontier; it is not a promotion gate.
A run stops at its captured frontier; invoke it again to consume later events.
The command has a 30-minute deadline and can resume after failure. It creates no
HTTP server. `KAFKA_BROKERS` must be supplied (local Compose: `127.0.0.1:59092`).

Safety properties:

- Every topic partition must retain offset zero. A lost prefix, checkpoint beyond
  the end, an offset discontinuity, validation error, collision or database failure
  stops replay. It does not silently quarantine and claim a complete rebuild.
- The canonical event/key/headers are validated before the tenant filter. Only the
  requested tenant's effects are written, through the existing inbox transaction
  and forced RLS. Foreign records advance only the selected tenant's replay scan
  checkpoint. Binding heartbeats are validated but do not refresh feed freshness.
- Migration 000003 adds a tenant-scoped, forced-RLS manifest binding progress to
  immutable Kafka topic IDs and the configured hot window. Recreated topics or a
  changed window require a new shadow. Historical source retention and history
  retention are separate: cold events still update inbox/latest/gaps, but do not
  recreate history outside the configured hot window.
- A transaction advisory lock serializes replay runners for one shadow. Progress
  is saved after the event effect commits, then the isolated broker group
  `<shadow database>-<tenant UUID>` is committed. A crash between these operations
  safely re-delivers through inbox idempotency. The database is the authoritative
  progress store; broker offsets are reconciled from it on restart. Do not run a
  normal live consumer or other writers against a replay shadow.

The tenant replay command never promotes a shadow. Versioned `read_vN` schemas,
canonical-source comparison, an atomic view swap function, and a continuous
versioned consumer exist and pass a disposable cutover test. A production swap
command and deployed cutover procedure are still required. The service handles
the device/telemetry contracts; facility projections remain a separate extension.
No recovery beyond canonical retention is promised; outbox republishing must
preserve IDs and is a separate operation.

`go run ./cmd/provision-version read_v1` provisions a fresh version in the
existing `greenguard_read` database using `PROJECTION_MIGRATION_URL` and the
restricted `projection_migrator` role. It applies the current projection DDL in
one transaction, forces RLS on tenant tables, and refuses an existing schema.
`Store.Schema = "read_v1"` routes its event transaction to that version. The
replay command accepts `--version 1` and uses the versioned schema for effects,
replay progress, manifest and comparison, with its own broker group. It requires
`PROJECTION_DATABASE_URL` to point to `greenguard_read` as `projection_app` and
checks forced RLS before consuming. The original separate-database command path
remains available when `--version` is omitted. Versioned replay does not switch
readers or start a live consumer; no schema is promoted automatically.

To keep a version current after finite replay, start a separate
projection-builder process with `PROJECTION_WRITE_SCHEMA=read_vN` and a
restricted `projection_app` URL for `greenguard_read`. It resumes the same
versioned Kafka consumer group and writes subsequent events into that schema.
Startup rejects an invalid schema, database or role, and checks that the
versioned tables have forced RLS. Keep this process running while the version
is under review. This alone does not authorize a view swap: the promotion
verifier still requires a durable readiness proof for this process, and
production `read.*` routing remains unchanged.

Migration 000008 adds a per-version PostgreSQL lease. A versioned writer acquires
it before consuming, renews it every ten seconds, and checks its token and epoch
under a row lock in each event or heartbeat transaction. A crash leaves the row
until its 30-second database-clock expiry; a replacement increments the epoch.
The writer advances the global replay frontier atomically with its effects,
including duplicate offsets. Replay refuses a version while its writer lease is
active. The canonical promotion verifier locks and rechecks the target lease
after comparison, then uses one transaction to replace the read views. The
lease does not guarantee process availability after transaction commit; monitor
the promoted writer and retain the old version for rollback. No production swap
command is enabled yet.

For a complete versioned scan, set `PROJECTION_REPLAY_TENANT=all` with
`PROJECTION_REPLAY_SCHEMA=read_vN` and run the Go replay command. It reads every
partition from offset zero to a captured frontier using the independent group
`greenguard.projection-builder.read_vN`. Global progress and the source manifest
are stored under the reserved infrastructure tenant in that version. Migration
000005 also keeps a forced-RLS registry of tenant IDs observed during the scan;
projection effects still use each event's tenant context. `compare all` requires
every partition to reach the captured frontier and checks every registered tenant
against the pure-Go fold of that tenant's immutable inbox. A source prefix loss,
invalid event, failed tenant write or failed registry write stops the scan before
progress advances. Resume uses database progress, then reconciles broker offsets.
This comparison does not independently read the canonical topic or compare the
live read version, so it alone cannot authorize promotion.

For executable local acceptance:

```sh
node --env-file=.env scripts/projection-replay-test.mjs
```

The acceptance test creates and removes a unique
`greenguard_read_replay_test_<timestamp>` PostgreSQL database, records the existing
Kafka frontier **before creating a new random tenant**, appends three canonical
fixture records (including a duplicate and a foreign tenant), injects failure
between effect and progress commit, then invokes the real replay entry point
twice. It checks one inbox/history/latest/notification effect and tenant exclusion.
Fixture events and the isolated consumer group remain on the broker. This proves
incremental recovery at a known frontier, not a full historical rebuild or swap.
Unit tests also cover lost retention, rejected events and actual protocol offset
commits against franz-go's in-process broker; database tests prove manifest RLS
and changed topic/window rejection. See Stage 05b evidence for executed results.

### Placement routing

`SHARD_REGISTRY_FILE` enables four-primary placement routing through the shared Go registry. Customer events resolve the authenticated control-plane placement before BEGIN; inbox, effect, completion, watermark and notification remain one owner transaction. Infrastructure barriers and version writer leases admit the reserved tenant independently on each configured shard. Versioned readiness checks every shard lease. Operational replay currently rejects registry mode explicitly; it needs a shard migration/replay protocol before sharded promotion is admitted. See [Go sharding contract](../../packages/go-common/SHARDING.md).
