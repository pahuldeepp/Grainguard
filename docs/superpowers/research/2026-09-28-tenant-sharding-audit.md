# GreenGuard database scaling audit and proposed roadmap

Status: proposal for design review, not an approved implementation specification.
Read-only parallel audits covered database ownership, read/cache consistency,
and platform deployment/event integration. No new sharding code, tests, or AWS
resources were changed during this audit. The existing replica/CDN candidates
are uncommitted and have not passed their own acceptance gate.

## Intent and constraints

Scale tenant data safely while preserving OAuth/OIDC, membership validation,
RLS, outboxes, existing table partitioning and Redis Cluster caching.
Start with one PostgreSQL read replica. Verify correctness before enabling
replica cache fills. Then introduce durable tenant placement, transaction-level
ownership fencing and tenant movement. The user accepts a short write pause
at final cutover. Hot-tenant Redis distribution changes require measurements.
Production remains out of scope; the disposable AWS readiness gate stays closed.

## Evidence from the current checkout

| Area | Existing implementation | Missing or unproved |
| --- | --- | --- |
| PostgreSQL | Eleven owner databases, runtime/migrator roles, transaction tenant context and RLS | Physical tenant shard routing and migration |
| Placement | organizations.home_region, cell_id, routing_epoch columns | Resolver, controlled placement transitions and database admission fences |
| Read replica candidate | One default RDS replica, configurable 0–5; TLS/read_query pools; connection pinned before transaction | Lag admission, health exclusion, fallback policy and correctness tests |
| Read API scaling | HPA enabled; shared min 2/max 10 | Connection budgets with surge, draining pods and all other services |
| Redis | Cluster client, tenant hash tags, generations/device versions, recovery epoch | Tenant placement fence and fresh-result cache admission |
| PostgreSQL history | Daily observed_at partitions with RLS | Not a replacement for cross-database sharding |
| Cassandra | tenant/device/day partition keys, per-device watermarks | Independent freshness proof during PostgreSQL moves |
| OpenSearch | Tenant filters, resource versions and alias promotion | Source lineage and old-event behavior under shard moves |
| CDC | Eight fixed connector definitions for one source RDS host | Per-shard identity, slots/publications and checkpoint lineage |
| Jobs/sagas/providers | Durable intents, inboxes, leases and delivery deduplication | Ownership-aware handling during moves |
| Cloud deployment | Terraform/Helm/Argo, guarded teardown | Multiple bundle bootstrap/inventory and live acceptance |

Key sources:
- infra/compose/init-databases.sql and infra/gitops/disposable/rds-bootstrap-chart/files/init-databases.sql
- services/tenant-control-plane/prisma/migrations/20260925090000_control_plane/migration.sql
- services/read-api/src/replicas.ts, main.ts, backends.ts, cache.ts and redis.ts
- packages/read-model/src/index.ts and packages/go-common/tenant.go
- services/cache-invalidator/worker.go and keys.go
- services/projection-builder/migrations/000002_history_retention.up.sql
- services/cassandra-writer/history/schema.go
- infra/kafka/connectors/ and infra/gitops/disposable/connector-registration/
- infra/terraform/disposable/read-replicas.tf, gitops.tf and destroy-verified.sh

Worker lease buckets, projection promotion epochs, Redis recovery epochs and
organization routing epochs have different meanings. They must not be treated
as an existing end-to-end tenant ownership protocol.

## Approach comparison

1. **Application-routed tenant shard bundles (recommended).** Preserve existing
   owner database boundaries, group a tenant's operational ownership in one
   bundle, and use the existing control plane as placement authority. Fits RDS
   and current service/outbox architecture; requires explicit routing/fencing.
2. **Independent placement for each service.** Enables individual growth, but
   multiplies placement state, partial moves and cross-service coordination.
   Defer until a measured need justifies it.
3. **Distributed PostgreSQL such as Citus.** Changes the database platform and
   requires compatibility proof for RLS, functions, transactions, migrations and
   CDC. It does not remove application cache/ownership consistency problems.

## Proposed architecture

Keep identity, membership and placement authoritative in the control plane.
Billing/provider reconciliation stays centralized initially. A PostgreSQL bundle
contains tenant-owned inventory, telemetry, risk, alerts, read projections,
sagas, jobs, notification and hardware state, with separate logical databases
and roles as today. A bundle has one primary and optional read replicas.

Keep Redis, Kafka, Cassandra, OpenSearch, DynamoDB and S3 tenant-keyed and shared
within the initial deployment. Their existing data is not copied merely because
PostgreSQL placement changes. Every background consumer still needs ownership
and event-lineage handling. Long-lived alert streams and mobile queues must
re-resolve placement through trusted server paths; client tenant headers never
become placement authority.

Do not use hash(tenant) modulo a changing shard count. Use stable shard IDs and
explicit durable tenant assignments. Terraform resources use stable map keys;
Argo bootstrap, migrations, Secrets, PgBouncer and connector records identify
shard ownership. Destroy refuses to retire a shard still owning active tenants.

## Replica and cache consistency design

Define eventual and minimum-watermark read modes. Membership, tenant state,
placement and entitlement authorization remain on their existing authoritative
paths. Select a healthy eligible replica before BEGIN; never move or replay an
open transaction. A replica unable to satisfy freshness uses a new primary
read before business SQL, or a controlled failure, according to endpoint policy.

Use an owning read-model watermark checked in the same transaction/snapshot as
the query. A source service's WAL position cannot certify an asynchronously
projected read database, Cassandra or OpenSearch. Physical replay checks must
include source identity/incarnation; raw LSNs across servers are not comparable.
Operational ReplicaLag metrics support monitoring, not per-request correctness.

Existing invalidation can advance a Redis generation before a replica catches
up. Prevent that replica from filling the new generation with old rows. Entries
carry placement epoch and the required result watermark. Revalidate admission
at fill and, for strict cutover reads, before response completion. Preserve
{t:tenant} tags so tenant guard/lock/data keys can share one Lua slot. The global
Redis epoch is in another slot; do not claim one atomic cross-slot comparison.

At ten Read API pods the candidate pools allow 100 primary plus 50 connections
per replica, before other services, rollout surge and draining pods. Define and
enforce per-endpoint budgets before increasing replicas or HPA bounds.

## Proposed execution sequence and acceptance gates

### 1. Finish and prove one replica

Review the candidate Terraform/pool/CDN code. Add lag/read-mode admission,
endpoint health exclusion, bounded fallback and pool budgets. Verify RDS CA
mounts, restricted read_query role, primary authorization and static-only CDN
caching. Test transaction affinity and isolation, paused replay followed by
invalidation/cache miss, outage/recovery and post-write visibility. Authenticated
API/config responses must remain uncached. No shard work bypasses this gate.

### 2. Establish one-shard placement authority

Extend organizations rather than introduce a competing directory. Add a shard
registry, explicit move state, compare-and-set placement changes and durable move
ledger. Resolve verified tenant into shard ID, epoch and admission state. Start
with all tenants assigned to the existing shard. Specify bounded control-plane
outage behavior; an expired route never silently selects another owner.

### 3. Enforce placement in every transaction and worker

Add shared TypeScript, Go and Python admission helpers. An operation locks a
local durable tenant ownership row, verifies epoch/state, and keeps that lock
through commit. Fence operations lock the same row and wait for admitted work.
Include HTTP writes, ingest, projectors, saga timers, jobs, exports, notifications
and hardware acknowledgements. Preserve RLS, inbox/outbox atomicity and receipts.

### 4. Bring up a second local bundle

Run every owner migration and permission check on both bundles. Route by tenant,
not process-global pool alone. Generalize fixed CDC host/connector assumptions;
each source needs unique connector identity and slot/publication configuration.
Keep canonical event IDs stable, preserve source lineage, and verify consumer
routing before side effects. Demonstrate tenant isolation and independent health.

### 5. Add short-pause migration

Persist every transition and make retries resumable:
prepare target -> snapshot/catch-up -> pause tenant write admission and background
mutations -> drain admitted transactions and accepted side effects -> capture
barriers and final delta -> fence source -> verify target -> publish new epoch
-> establish target/cache admission -> resume target.

These steps span databases: use a persisted fail-closed orchestration protocol,
not a bare dual-write. Temporary neither-owner admission is acceptable during
the agreed pause; simultaneous owners are never acceptable. Preserve event IDs,
inboxes, command receipts, versions and external delivery deduplication. Copied
outboxes must not blindly republish historical side effects. Delayed accepted
old-epoch events need an explicit drain/replay policy, not blanket discard.

Before target admission, abort may restore source using a new epoch. After target
accepts writes, recovery proceeds forward or performs a separately fenced reverse
move with another new epoch. Never decrement epochs or automatically fail over
to the former owner. Retain fenced source data until validation/retention gates.

### 6. Failure and recovery proof

Crash/restart at every move transition; concurrent move request; stale router,
worker and transaction; Redis outage/failover; delayed CDC; replica lag; lost
connection; invalid copy; active saga/provider delivery; migration rollback and
DR restore. Prove no lost admitted write, no duplicate provider action, no
cross-tenant data and no old-epoch refill. Define expected temporary failures.

### 7. Disposable AWS acceptance and ownership

Expand Terraform/Argo/Secrets/CDC/monitoring using stable shard IDs. Test migrations,
RLS, replica freshness, shard routing and movement against real RDS/EKS. Exercise
web/iPhone login, tenant data, live alerts and ACK without replacing OAuth.
Inventory every primary/replica, secret, connector, PVC, load balancer and KMS
resource on teardown. Raw terraform destroy's final-inventory limitation remains
an existing deployment gap; do not describe this as solved by adding shards.

Measure routing/epoch denials, move downtime, projection/replica watermarks,
connection usage, cache fill rejection, CDC backlog and provider deduplication.
Only then consider hot-tenant Redis buckets or additional database replicas.

## Design review decisions

Confirmed: one initial replica, preserve current Redis layout, short cutover
write pause acceptable. Proposed: application-routed operational tenant bundles,
central control plane/billing, shared distributed stores initially, and persisted
fenced migrations. Review this approach before producing the formal written
specification and task-level implementation plan required by brainstorming.

Technical references:
- https://www.postgresql.org/docs/15/functions-admin.html (WAL/replay positions)
- https://debezium.io/documentation/reference/stable/connectors/postgresql.html (source/slot/publication ownership)
- https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/ (hash slots and multi-key locality)

## Completed CodeRabbit candidate reviews

Both scoped CLI reviews completed using the free CLI allowance. They reviewed
uncommitted candidates, not the entire codebase or the future sharding implementation.

- Read API: reviewed `src/backends.ts`, `src/main.ts`, and `src/replicas.ts`.
  One major finding remains open: readiness probes every replica and routing
  includes unhealthy pools, so one failed replica can remove all Read API pods
  from service. Implement per-pool eligibility and bounded failure handling.
- Disposable Terraform: reviewed `edge.tf`, `gitops.tf`, and `read-replicas.tf`.
  One critical finding remains open: the replica explicitly sets `storage_type`
  to `gp3` without `iops`. The CreateDBInstanceReadReplica API requires IOPS when
  that storage type is supplied. Remove the explicit setting or configure a
  valid source-compatible combination and validate the provider configuration.
  Reference: https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_CreateDBInstanceReadReplica.html

Both findings were checked against current candidate source. Fixes and regression
validation belong to the implementation phase after the written design/plan
review required by the invoked brainstorming skill. Candidate code is not accepted
or committed by this design milestone. CLI logs are local temporary artifacts:
`/tmp/greenguard-shard-coderabbit-read-api.log` and
`/tmp/greenguard-shard-coderabbit-terraform.log`.

The written specification incorporates independent database and cache reviews,
including repeatable-read snapshot consistency, accepted-work drain closure,
atomic local fence/activation receipts, positive abort eligibility, and watermark
rebasing. Documentation whitespace checks and placeholder scans passed. No new
product tests or AWS operations were run for this design-only milestone.
