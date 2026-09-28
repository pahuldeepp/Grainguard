# Tenant sharding, read replicas and cache consistency

Status: written specification awaiting user review. Architecture approved in
conversation; implementation has not been approved against this written spec.
Scope: finish one read replica, then implement physical tenant sharding and
resumable short-pause moves across two local bundles, followed by disposable AWS
acceptance. Existing replica/CDN edits remain candidates, not verified features.

## 1. Intent and agreed constraints

GreenGuard must scale reads and tenant-owned writes without weakening tenant
isolation, changing working OAuth/OIDC, losing accepted commands or duplicating
external effects. Start with one database replica; API pod count is independent.
Keep Redis Cluster tenant hash tags and existing partitioning. A short tenant
write pause is acceptable during migration. Production must not be touched.
No real AWS apply occurs until the wider pre-deployment audit is green.

Success means executable proof for replica consistency, routing, source fencing,
tenant moves and recovery across every synchronous and background path, plus
later web/iPhone workflows and complete disposable teardown. Static renders are
not live proof. Tests cannot substitute one local database for two physical
shards or replace a real streaming replica with two independent writable DBs.

## 2. Current architecture and correction of terminology

Eleven PostgreSQL databases share the current instance. Services own schemas,
roles, transactions and migrations. Domain writes generate transactional outbox
events; Kafka/projectors populate separate read models. This is already CQRS.
A physical RDS replica copies the instance; it does not create the CQRS model.

Daily PostgreSQL history partitions and Cassandra tenant/device/day keys remain.
Redis Cluster supports tenant-tagged caches, device versions and tenant generation
invalidation. Read API HPA is already enabled. Organizations already have
home_region, cell_id and routing_epoch, but runtime ownership routing is absent.
Saga dispatch buckets, projection writer/promotion epochs and Redis recovery
epochs do not constitute physical shard ownership.

Evidence and alternatives are recorded in
[the audit](../research/2026-09-28-tenant-sharding-audit.md).

## 3. Deployment and data ownership

Use application-routed operational tenant bundles. Each stable shard ID owns a
private PostgreSQL primary, zero or more read replicas, distinct endpoint/role
Secrets, PgBouncer targets, migration history, CDC sources and health metrics.
Preserve separate logical databases for inventory, telemetry, risk, alerts,
read projections, jobs, notifications, sagas and hardware.

Keep the control database authoritative for identity, memberships, organization
state and placement; keep billing/provider reconciliation centralized initially.
Tenant projections of control/billing state inside operational databases remain
owned by their projectors and must be copied/reconciled with the tenant bundle.
Control-plane audit exports that read operational owner data use tenant routing;
they cannot retain a fixed connection to the former shard.

Redis, Kafka, Cassandra, OpenSearch, S3 and DynamoDB remain shared in the first
implementation. Their tenant data is not moved just because PostgreSQL moves.
Consumers, live streams and provider delivery intents must nevertheless respect
placement, source lineage and deduplication. OAuth identities and device IDs do
not change during a move. No alphabetic or modulo-shard-count routing.

## 4. Read replica policy

Expose explicit eventual and minimum-watermark modes. Membership, tenant state,
placement and entitlement authorization retain authoritative paths and existing
freshness checks. Primary authorization does not make all projections current.

Eligibility requires verified TLS/hostname, read_query permissions, schema/grants,
expected source incarnation and bounded health checks. Connectivity alone does
not prove freshness. Exclude an unhealthy endpoint without making every API pod
unready if an allowed primary path is healthy. Select an endpoint before BEGIN;
never switch, replay or retry a transaction after business SQL starts.

For a minimum-watermark read, check the durable owning-store watermark inside
a REPEATABLE READ READ ONLY transaction snapshot used for business queries.
The current READ COMMITTED helper must be changed for this path; separate
statements under READ COMMITTED do not establish one consistent snapshot. If a replica cannot satisfy
it within the request deadline, end that attempt before business SQL and start
one primary read, or return controlled unavailable when the primary also cannot
satisfy the watermark. Retry bounds share the original deadline. No silent
consistency downgrade and no automatic writer promotion.

Each projection transaction advances a tenant-local monotonic read-model sequence
and emits that sequence in its transactional notification. The update serializes
on that tenant's watermark row, so sequence reflects committed visibility rather
than wall-clock timestamps. A read establishes a consistent snapshot before
checking sequence and rows. Rollback exposes neither increment nor notification.
Eligibility retry occurs outside the business transaction: a below-minimum
snapshot ends before business SQL, and a new attempt obtains a new snapshot.
Polling inside one repeatable-read snapshot cannot observe replay progress.
Source completion maps each accepted event/aggregate version to a committed
projection watermark; a maximum observed version alone cannot prove contiguous
completion across partitions or concurrent handlers.

Sequence identity includes shard incarnation and placement epoch; compare only
within that identity. This introduces per-tenant serialization of projection
watermarks, which must be load-tested before acceptance.

For source-write read-your-writes, carry the source aggregate/event version and
wait for its projection completion, then enforce the read-model sequence.
A source PostgreSQL WAL position cannot certify another asynchronous read DB,
Cassandra or OpenSearch. Those stores require their own checkpoint/version proof.

Pool limits are per endpoint. Account for HPA maximum, rollout surge, draining
pods, probes, every service and migration/CDC connections. Defaults remain bounded;
replicas and HPA cannot be increased beyond the reviewed connection budget.

## 5. Placement authority and resolver

Extend organizations with explicit shard assignment and placement state. Add a
shard registry and a durable tenant move ledger with operation ID, expected epoch,
source/target, source incarnation, barriers, validation receipts and transition
version. Existing routing_epoch is a monotonically increasing BIGINT serialized
as a decimal string at API/event boundaries. Never decrement or reuse it.

Trusted service resolution returns tenant ID, shard ID, epoch and admission state.
Only verified tenant identity selects placement; client-provided shard/epoch
headers cannot override authority. Database credentials come from a private
endpoint registry, not from placement responses or user input.

Cached placement has an explicit expiry and invalidation subscription. Existing
requests may use unexpired routes subject to local database fences. Expired or
unknown placement fails closed; do not select the first healthy shard. Onboarding
and moves stop when authority is unavailable. Membership revocation rules remain
independent and unchanged. Metrics distinguish stale placement from authorization.

## 6. Transaction and worker ownership fences

Every operational owner DB has a durable tenant ownership row containing shard
incarnation, routing epoch and state (prepared, active or fenced). Writers verify
trusted placement inside their transaction and hold a shared row lock until
commit. Fencing takes the conflicting exclusive lock, waits for admitted writers,
and persists the fenced state. Shared locks permit concurrent ordinary writers.

Shared TypeScript, Go and Python helpers set tenant/epoch context and verify the
row. Tenant mutation triggers enforce the same admission contract, including
security-definer/projector paths, so omission of a helper cannot silently bypass
ownership. Runtime roles cannot alter ownership rows or disable triggers.
Enforce INSERT/UPDATE/DELETE; prohibit runtime TRUNCATE and tenant-ID changes.
Guard functions validate tenant, epoch, incarnation and admission class, use a
fixed search_path and narrow SECURITY DEFINER privileges. Runtime roles cannot
set replication role, disable triggers, call copy/bootstrap procedures or modify
ownership. Admission classes are normal, trusted pre-barrier drain and audited
copy/bootstrap; the latter cannot publish business events or external effects.
Migration/bootstrap roles have separately audited procedures; bypasses must be
explicit and cannot be used by normal traffic.

Read-only replica transactions cannot take PostgreSQL row locks. They read a
snapshot fence and verify its epoch, then require authoritative placement/cache
admission before strict response/fill admission. A strict response obtains a read-admission lease from
placement authority for its epoch; cutover stops new source leases and drains
existing leases before publishing the target epoch. The guarantee is linearized
response admission, not when bytes reach a client: a response admitted before
cutover may finish delivery afterward. Leases have bounded expiry and renewals;
a request that loses its lease cannot authorize a fill or response. A replica's stale local fence
is never sufficient to authorize writes or certify cutover ownership.

Include APIs, ingestion, event projectors, saga timers/leases, jobs, notifications,
hardware commands/ACKs, exports, batch tasks and scheduled maintenance. External
calls are not protected merely by holding a DB row lock: pause admission to new
provider work and drain/reconcile durable in-flight intents and idempotency keys.
Ownership change cannot imply exactly-once behavior from a provider lacking an
idempotency contract; ambiguous effects remain blocked for reconciliation.

## 7. Redis and CDN

Keep {t:tenantId} tags. Cache identity gains placement epoch and source incarnation;
entry metadata includes the read-model watermark. Tenant guard keys record current
admission epoch and minimum visible sequence. Same-slot Lua compares guard, lock,
and result before fill. Generation/device invalidation advances its required
sequence monotonically and rejects a refill from a lagging replica.

The global Redis recovery epoch is outside the tenant slot; it cannot participate
in the same atomic Lua comparison. Preserve its existing recovery role and treat
it as a separate namespace invalidation, not durable ownership authority.

A cache hit still requires trusted placement admission. Thus routing is usually
resolved cheaply from bounded local metadata even on hits; only database pool
selection/origin access is limited to misses. A stale router cannot keep serving
an old epoch indefinitely just because its cache has entries. Strict cutover
responses require the authority-backed read-admission lease; responses already delivered
before cutover cannot be recalled. Replica/cache failure bypasses to an eligible
primary under the same tenant fence, never to arbitrary shard data. Missing
Redis guards or Redis recovery require durable placement/watermark lookup and
cache bypass until guards are rebuilt; absence is never interpreted as epoch or
sequence zero. A fill capability is bound to its authority-backed lease and
same-slot epoch/sequence guard; the move drains/revokes these capabilities before
advancing placement. Redis and local TTLs alone cannot grant a strict lease.

CDN caches content-hashed web assets only. HTML, runtime config, OAuth flows,
GraphQL and authenticated APIs retain disabled caching. Missing assets must not
be cached as successful SPA HTML. Hot-tenant Redis distribution stays unchanged
until measurement justifies new buckets and their invalidation protocol.

## 8. CDC and source lineage

Generate connector names, source prefixes, publications, slots and endpoint
credentials per shard/database. Preserve canonical tenant/event/aggregate identity
and existing partition ordering requirements. Kafka offsets remain scoped to
source topic/partition lineage; PostgreSQL LSNs are scoped to source incarnation.
Do not reset shared offsets or compare LSNs from different sources.

Tenant snapshots copy durable inboxes, receipts, versions and outbox rows with
publication admission disabled on the target. Copying rows must not replay old
provider commands or generate duplicate trigger outboxes. CDC bootstrap/snapshot
mode and logical topic mapping are recorded in the move manifest. Accepted
old-epoch events drain through the source before the barrier, or are explicitly
reconciled/replayed into the target preserving identity. Do not blanket discard
old epochs that contain accepted, unapplied work.

## 9. Resumable short-pause migration

One compare-and-set move operation per tenant. Steps are persisted and idempotent:

1. Validate target schema/grants/capacity and create prepared ownership rows.
2. Copy a tenant snapshot and catch up under an explicit per-owner manifest.
3. Mark placement quiescing and stop new external/user work, scheduled root
   tasks and independent provider intents. Close new source read/fill leases.
4. Drain admitted transactions and previously accepted asynchronous work.
   Continuations may execute only with a server-issued drain capability tied to
   the move operation and recorded accepted intent/event ancestry. Triggers
   validate this capability against the durable move/admission record; callers
   cannot self-assert it. Source stays active for this finite drain set only.
   Capture initial per-source barriers, track downstream continuation closure,
   and capture final barriers after no accepted work can generate another
   continuation. Reconcile external effects, exports, timers and notifications.
   Drain read/fill leases as well. Every move has a configured finite pause/drain
   deadline; inability to reach closure leaves the tenant quiesced for operator
   recovery or an explicit abort, never permission to skip unapplied work.
5. Exclusively fence source ownership rows across every operational owner DB.
   Partial fencing remains quiesced and resumable; no target accepts writes.
6. Apply final delta. Validate canonical row counts/digests, versions, FKs,
   receipts/inboxes/outboxes, projection barriers and target replica readiness.
7. Commit durable source-fence and target-validation receipts to the control-plane
   move ledger. CAS assignment to target and advance epoch while still quiesced.
8. Install target ownership and Redis guard at the new epoch. Activate target
   through a guarded procedure tied to the authorized durable move record.
9. Publish active placement and resume tenant work. Retain source fenced for
   validation and configured disposal retention.

There is no cross-DB atomic commit. The safety rule is a persisted protocol with
neither-owner admission allowed during the pause and never both-owner admission.
Fencing atomically updates local ownership and inserts an immutable local receipt
for the move operation. Authority records it only after verifying committed local
state. Lost acknowledgements are recovered by operation ID. Target activation
atomically validates operation/epoch/incarnation, changes admission and persists
an activation receipt; any admitted mutation also advances a protected work marker.
Abort positively verifies each target remains prepared with no activation receipt
or admitted-work marker; a missing control acknowledgement is never that proof.
Partial reactivation remains quiesced and follows a new epoch.

Target activation requires receipts from every source owner; authority outage or
uncertain receipt stops activation. A cache guard is not that receipt.

Before target activation, abort may reassign source at a new epoch after verifying
that target never admitted work. After target activation, recovery is forward;
a reverse move is a new fenced operation at another epoch. Automatic failback,
epoch decrement, destruction of an active owner and blindly retrying ambiguous
provider effects are forbidden. Restart reconstructs state from ledgers/receipts,
not worker memory. Final-delta capture enumerates every tenant table, including
receipts/checkpoints/leases not present in outbox CDC. The move manifest records
copy method and trigger suppression per table. Target projection sequence identity
is rebased under the new incarnation/epoch with a validation mapping for copied
source barriers; old and new sequence numbers are never compared directly.
Restore creates a new incarnation and advances epoch before
traffic admission; old credentials/processes remain fenced.

## 10. Local and cloud topology

First preserve a single-shard compatibility mode using the resolver and fences.
Then create two independent local PostgreSQL bundles plus a real streaming replica
for lag tests, while using the existing shared Redis Cluster/event stack. Apply
all owner migrations and RLS/grant checks to both. Central control/billing fixtures
remain separate. Bootstrap is repeatable and does not mutate unrelated local data.

Terraform uses stable for_each shard IDs and explicit replica maps, not list
positions. Argo migration, Secret, PgBouncer and connector inventories derive from
that manifest. Singleton assumptions in bootstrap, DR and teardown are removed.
Account/environment guards remain. Retiring a shard requires no active tenant
assignment or open move and a saved scoped inventory. Every replica, managed
secret, connector, volume and cloud resource is included in teardown acceptance.
The existing raw terraform destroy post-inventory gap remains a separate blocker.

## 11. Verification and release gates

| Gate | Required evidence |
| --- | --- |
| Replica | TLS/RLS and permissions; real paused replay; invalidation followed by stale miss cannot refill current cache; eligible routing and bounded fallback; pool budget; CDN asset/API cache behavior |
| Placement | CAS contention; trusted tenant selection; expiration/outage; BIGINT epochs; compatibility routing; no stale write admission |
| Two shards | Every service and worker path; schema/grants; tenant isolation; inbox/outbox atomicity; source lineage and independent health |
| Move | Successful snapshot/final delta/short pause; accepted work drained; old source read/write/fill denied; no lost commands or duplicate provider effects |
| Faults | Crash each step; partial fences; stale worker; Redis/replica/control outage; copy failure; delayed CDC; active export/notification; forward recovery and new-epoch reverse move |
| Local E2E | Web/API sign-in, tenant data, alerts/live updates/ACK across a move; mobile queue/reconnect behavior; full verify/coverage gate |
| Review | CodeRabbit request-changes resolved; regression tests; scope documented |
| AWS | RDS/EKS routing/lag/move proof, web and physical-iPhone OAuth/API acceptance, Stage 11/12/13 evidence, destroy and final scoped resource inventory |

Observability: per-endpoint pools/lag/watermarks, route/fence rejection, source
barriers, tenant move state/downtime, cache fill rejection, queue backlog and
provider reconciliation. Tenant IDs are not unbounded metric labels; store detail
in protected logs/traces and aggregate metrics by shard/state/reason.

## 12. Implementation boundaries and review handoff

Separate deliverables: replica/cache consistency; placement authority; transaction
admission across languages/services; two-bundle deployment/CDC; move orchestrator;
fault/E2E acceptance; disposable AWS ownership/acceptance. Each passes its gates
before the next depends on it. No Redis key redistribution or IdP replacement is
included. A detailed implementation plan must enumerate exact owner tables,
workers, manifests and tests from this spec before execution.

User review is required by the invoked brainstorming workflow. After approval,
use writing-plans to produce the execution plan, review it and select execution
method. This specification is a design deliverable, not proof of implementation.
