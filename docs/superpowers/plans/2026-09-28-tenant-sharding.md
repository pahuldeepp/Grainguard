# Tenant Sharding, Replica Freshness, and Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every tenant-owned PostgreSQL write and read to one of four explicitly assigned physical shards, prevent stale replica/cache reads, and move tenants safely among all four local shard bundles before disposable AWS acceptance.

**Architecture:** Keep the central control database authoritative for identity and tenant placement. Each physical shard bundle owns the tenant's existing operational PostgreSQL databases and their outboxes/read models, with one initial read replica each. Kafka, Redis Cluster, Cassandra, OpenSearch, S3, and DynamoDB remain shared initially; every event consumer carries source lineage and resolves tenant placement before writing.

**Tech Stack:** Go, TypeScript, Python, PostgreSQL/RDS, PgBouncer, Kafka, Debezium, Redis Cluster, Cassandra, OpenSearch, Terraform, Helm, Argo CD, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-28-tenant-sharding-design.md`

## Global Constraints

- Preserve existing OAuth/OIDC, membership authorization, RLS, tenant filters, transactional outboxes, event IDs, idempotency receipts, and Redis `{t:tenantId}` hash tags.
- Start with four physical shard primaries and one read replica per shard; each shard may configure replica count 0–5 only through guarded Terraform configuration.
- Do not route by alphabet, modulo shard count, request header, process-local default, or first healthy database.
- Verify tenant ownership inside every write transaction; fence by monotonically increasing BIGINT epoch serialized as a decimal string.
- A move has one owner at a time and uses the approved short write pause; ambiguous provider effects block cutover pending reconciliation.
- No production access or real AWS apply. Offline/local proof must be distinguished from AWS/live proof.
- All configured pool maximums must fit the reviewed HPA, rollout surge, service, worker, migration, and CDC connection budget.

## Review Focus

- Missing or expired placement: deny before any tenant database or cache access; test each service resolver.
- Concurrent source write and move fence: exactly one is admitted; test lock ordering and committed receipts.
- Replica below the required projection sequence: never cache the old value; test a new snapshot attempt and bounded primary fallback.
- Redis guard absent during outage/recovery: bypass cache and read durable authority; test that epoch zero is never assumed.
- Accepted asynchronous work at cutover: drain its bounded continuation closure or leave the move quiesced; test lost acknowledgement and crash recovery.

---

## File and Interface Map

- `packages/read-model/src/index.ts`, `services/read-api/src/{backends.ts,main.ts,replicas.ts,cache.ts}`: PostgreSQL read transactions and replica selection. Add a replica provider interface exposing `acquire(minimumWatermark, deadline) -> ReadConnection` and bounded readiness/health reporting.
- `services/tenant-control-plane/prisma/schema.prisma`, `prisma/migrations/**`, `src/domain/**`, `src/api/**`: authoritative shard registry, placement CAS, route lookup, move ledger and admission lease API. Stable contract returns `{tenantId, shardId, placementEpoch, state, expiresAt}`.
- `packages/go-common/**`, `packages/read-model/**`, Go services' `tenant.go`, and relevant Python tenant DB modules: shared write admission requiring `{tenantId, shardId, placementEpoch, admissionClass}` on the same transaction/connection as business SQL.
- `infra/compose/**`, `infra/gitops/disposable/rds-bootstrap-chart/**`, `infra/kafka/connectors/**`, `infra/gitops/disposable/connector-registration/**`: four independent local bundles and source-scoped CDC configuration.
- Owner service migrations and runtime services: durable ownership rows/triggers in every tenant-owned owner DB; projectors, workers, exporters, notifications, hardware, saga and provider intent paths resolve and fence placement.
- `services/cache-invalidator/**` and `services/read-api/src/cache.ts`: per-tenant epoch/sequence guards and cache fill admission.
- New `services/tenant-migrator/**` or a bounded control-plane worker (decision in Task 5 after inspecting runtime conventions): durable move state machine and receipts.
- `infra/terraform/disposable/{read-replicas.tf,gitops.tf}`, `infra/helm/greenguard-service/**`, `docs/runbooks/**`, `evidence/**`: disposable AWS configuration, health and operational evidence.

## Task 1: Make the single replica safe and independently healthy

**Files:**
- Modify: `services/read-api/src/replicas.ts`, `services/read-api/src/main.ts`, `services/read-api/src/backends.ts`
- Test: `services/read-api/src/replicas.test.ts`, `services/read-api/src/backends.test.ts`, Read API cache integration tests
- Modify: `infra/terraform/disposable/read-replicas.tf`, `infra/terraform/disposable/gitops.tf`, relevant Helm values/schema and `docs/READ_SCALING.md`

**Interfaces:**
- `ReplicaProvider.acquire({minimumSequence?, deadline})` returns one replica connection selected before `BEGIN`; it never switches after business SQL begins.
- `ReplicaProvider.health()` returns endpoint-level health; readiness succeeds when the approved read path is usable, not only when every replica is healthy.
- Existing APIs without a consistency requirement retain explicitly eventual behavior until caller supplies a source event/version requirement.

- [ ] Add tests for one failed replica with one healthy replica, all replicas failed, connection timeout, and shutdown pool close.
- [ ] Add a test proving a replica transaction is selected before `BEGIN` and is never replayed on a different endpoint after a query has started.
- [ ] Implement per-pool health and selection among eligible endpoints; remove failed endpoints from routing and retry health probes with backoff.
- [ ] Add durable projection sequence checks inside one `REPEATABLE READ READ ONLY` transaction snapshot; below-minimum result ends before business SQL and triggers a fresh attempt.
- [ ] Add one deadline-bounded primary fallback before business SQL, otherwise return a controlled freshness-unavailable error. Do not retry a partially executed transaction.
- [ ] Make CodeRabbit's RDS finding green: omit explicit `storage_type` or set a valid IOPS combination consistent with source storage; validate the Terraform provider configuration.
- [ ] Run Read API unit/integration tests, service typecheck/lint, Terraform fmt/validate and scoped CodeRabbit review. Record remaining live RDS lag proof as pending.

## Task 2: Add authoritative placement and shard registry

**Files:**
- Modify: control-plane Prisma schema and migration under `services/tenant-control-plane/prisma/`
- Modify: `services/tenant-control-plane/src/domain/organizations/**`, route/controller modules, DTO schemas, tests
- Modify: relevant contract files under `contracts/` and shared TS client package

**Interfaces:**
- `resolveTenant(tenantId)` returns a signed/validated route `{tenantId, shardId, placementEpoch, state, expiresAt}` from trusted control-plane state.
- `compareAndSetPlacement(tenantId, expectedEpoch, targetShardId, operationId)` advances epoch exactly once and is idempotent by operation ID.
- API accepts tenant identity from verified principal/context only; shard ID or epoch supplied by callers is rejected/ignored.

- [ ] Add migration tests for shard registry, default existing shard assignment for all existing organizations, uniqueness and BIGINT-to-decimal serialization.
- [ ] Add route resolver tests for active, quiescing, unknown shard, expired route, stale epoch, control-plane outage, and tenant mismatch.
- [ ] Implement bounded cache expiry/invalidation and fail-closed behavior; never infer a shard from health or assume shard zero.
- [ ] Implement placement CAS, move lock uniqueness, durable operation ledger and monotonic epoch rules.
- [ ] Run control-plane unit/integration tests and API contract compatibility checks; verify old OAuth and membership paths remain unchanged.

## Task 3: Enforce tenant ownership in database transactions

**Files:**
- Create migrations in each of the existing operational owner database migration trees; follow `infra/compose/init-databases.sql` and `infra/gitops/disposable/rds-bootstrap-chart/files/init-databases.sql`
- Modify `packages/go-common/tenant.go`, `packages/read-model/src/index.ts`, Python tenant DB helpers and each service-specific `tenant.go`
- Modify runtime permissions/bootstrap role SQL and service transaction entrypoints
- Test: shared Go/TS/Python helper tests plus DB integration tests for each owner role

**Interfaces:**
- `WithTenantPlacement(ctx, pool, route, admissionClass, fn)` begins a transaction, sets tenant context, locks/checks the local ownership row, and invokes `fn` before commit.
- Normal transactions can write only when local `{shardId, incarnation, epoch, state}` matches trusted route and is active.
- Trusted drain and copy/bootstrap admission require server-side capabilities tied to a durable move record; normal service callers cannot choose these classes.

- [ ] Add SQL tests proving wrong tenant, wrong shard, stale epoch, fenced state, forged drain capability, tenant-ID mutation and TRUNCATE are denied.
- [ ] Add concurrency test: a writer holding shared ownership admission prevents source fence until commit; a fence then prevents later stale writes.
- [ ] Add ownership rows and triggers to every tenant-owned operational DB, including projection DBs; define safe migration initialization for pre-existing tenants.
- [ ] Implement language helpers and migrate service write transactions without dropping RLS or existing tenant filters.
- [ ] Restrict ownership writes, trigger changes, replication role, bypass procedures and runtime TRUNCATE from runtime roles; separate migration/copy credentials.
- [ ] Run all affected service DB suites with two different tenant IDs and assert cross-shard and cross-tenant isolation.

## Task 4: Run four independent local database bundles

**Files:**
- Modify: `infra/compose/compose.yaml`, stage-specific overrides, database initialization and health scripts
- Modify: PgBouncer and RDS bootstrap charts under `infra/gitops/disposable/`
- Modify: Terraform shard modules/resources using stable `shard_id` keys, with complete outputs/secrets/teardown ownership
- Test: Compose startup, migrations, endpoint credentials, bundle isolation, scale/teardown scripts

**Interfaces:**
- Runtime configuration provides a registry of shard ID → private owner DB endpoints/credentials; tenant route contains shard ID only, never credentials.
- Every service can hold bounded pools for eligible shard owners and close them cleanly.
- Initial stable shard IDs are `s1`, `s2`, `s3`, and `s4`; no renumbering based on count.

- [ ] Add compose profile with four separately named PostgreSQL primaries and independently bootstrapped logical databases/roles.
- [ ] Run every owner migration against all four bundles and verify schema/grants/partition setup match.
- [ ] Add a smoke test placing four tenants on s1, s2, s3 and s4; write/read on each and assert no shard contains another shard’s tenants.
- [ ] Introduce bounded per-shard connection pools; enforce total connection budget under configured HPA and rollout maximums.
- [ ] Add stable Terraform `for_each` ownership for s1–s4 with one replica each by default and verify destroy inventory includes all four bundles, replicas, secrets, connectors and storage.
- [ ] Run full local compose verify, with all service migrations and smoke tests; save evidence and list any environment-dependent checks.

## Task 5: Route all services and background work by placement

**Files:**
- Modify: telemetry ingest `main.go`, transaction boundary and consumer runtime
- Modify: projection builder `main.go`, `store.go`, checkpoint/replay and promotion paths
- Modify: all other PostgreSQL writer service startup/transaction files identified by `rg 'DATABASE_URL|WithTenant' services/`
- Modify: saga, notification, hardware ACK, export, scheduled job, control export and provider workers
- Modify: Debezium connector generation and CDC transformer lineage handling
- Test: service-level route tests, event redelivery/reordering tests, wrong-shard and duplicate-side-effect tests

**Interfaces:**
- HTTP commands resolve placement from verified tenant principal before owner transaction.
- Event consumers validate tenant/event identity, preserve source lineage, and resolve current placement before database mutation.
- Outbox event IDs and inbox/receipt idempotency keys remain stable across shard routing.

- [ ] Inventory each service's tenant-owned tables, runtime database, writer, worker, migrations, external effects and tenant identity source; record a complete matrix as a plan appendix/evidence artifact.
- [ ] Convert API and ingest writes to `WithTenantPlacement`, including device-to-tenant resolution from trusted registration.
- [ ] Convert projectors and replay paths to tenant-aware owner DB pools; keep inbox, effect, checkpoint and notification atomic per shard.
- [ ] Convert saga/job/notification/hardware/export/provider paths; pause admission to external work when placement quiesces and reconcile idempotency keys.
- [ ] Generate one connector/slot/publication/source prefix per owner DB with stable IDs; consumer checkpoints remain scoped to source topic/partition lineage.
- [ ] Test replay, duplicate events, delayed old-source events, wrong-shard messages, cross-shard aggregate ownership and connector restart.
- [ ] Run all affected Go/TS/Python suites and scoped CodeRabbit review; prove no writer remains on a process-global fixed pool.

## Task 6: Add shard-safe read routing and Redis consistency

**Files:**
- Modify: `services/read-api/src/{main.ts,backends.ts,cache.ts,replicas.ts,app.ts}`
- Modify: `services/cache-invalidator/{worker.go,keys.go,main.go}`
- Modify: projection watermark/notification migrations and publisher in `services/projection-builder/`
- Modify: BFF consistency token propagation in `services/bff/src/read-client.ts` and client contracts where needed
- Test: Redis scripts, replica lag tests, placement change races and multi-store consistency tests

**Interfaces:**
- Every tenant read resolves trusted placement before cache admission; cache entries include source incarnation, placement epoch and owning-store sequence.
- Minimum-consistency reads pass a minimum projection sequence; eventual reads state that policy explicitly.
- Invalidation advances a tenant/device minimum sequence monotonically; fills atomically compare the current guard, lock and result in the tenant's Redis hash slot.

- [ ] Add tenant-local committed projection sequence rows; update sequence and publish notification in the same projection transaction.
- [ ] Map source event/aggregate versions to projection completion without assuming max-seen implies contiguous completion.
- [ ] Add Redis tenant guard and fill validation Lua; absent guard or recovery uncertainty bypasses Redis and consults durable placement/watermark.
- [ ] Bind response/fill admission to bounded placement read leases; a lost/expired lease prevents response admission and cache fill.
- [ ] Route PostgreSQL misses to that tenant shard's eligible replica, then permitted primary fallback; route Cassandra/OpenSearch through their own version/checkpoint semantics.
- [ ] Preserve authorization before cache response, tenant filters and RLS. Keep entitlements/membership/placement authoritative.
- [ ] Test stale refill race, post-write minimum read, cache outage/recovery, old shard lease rejection, missing guard, replica lag and source incarnation mismatch.

## Task 7: Implement resumable tenant move protocol

**Files:**
- Create or extend move orchestrator in the control-plane worker convention selected during implementation
- Modify control-plane move ledger/CAS API and per-owner migrations/procedures
- Modify snapshot/copy/reconcile utilities and CDC source configuration
- Modify runbooks under `docs/runbooks/tenant-shard-move.md`
- Test: move state machine, fault injection at each transition, independent four-shard integration harness

**Interfaces:**
- `startMove(tenantId, targetShardId, expectedEpoch)` returns durable `operationId`.
- `advanceMove(operationId)` is idempotent and may only advance after verifying local committed receipts for all owner DBs.
- `abortMove(operationId)` succeeds only after positive proof that target has no activation receipt and no admitted-work marker; recovery after target activation moves forward or runs a separately fenced reverse move with a new epoch.

- [ ] Add state transition and CAS tests; reject concurrent moves and all epoch regressions.
- [ ] Prepare target schema/ownership; copy snapshot with publication disabled; verify tenant row counts, canonical digests, FKs, inboxes, receipts, outboxes and version state.
- [ ] Catch up source-scoped CDC and record per-owner/source barriers without comparing unrelated LSNs or resetting shared offsets.
- [ ] Quiesce new work, issue trusted drain capabilities only for recorded accepted intent ancestry, drain API writes, event continuations, provider effects, exports, timers and read/fill leases to a finite deadline.
- [ ] Fence each source owner DB with atomic local receipt; recover lost acknowledgements by operation ID; keep all owners quiesced on partial fencing.
- [ ] Apply final delta, rebase per-store watermarks, verify target replica readiness and persist target validation receipts.
- [ ] CAS placement and epoch while quiesced; install Redis guard; atomically activate target with activation receipt/work marker; resume target work.
- [ ] Inject crash/lost-ack at every state edge and prove no dual owner, no lost accepted work, no duplicate provider action and a documented recoverable state.

## Task 8: Validate whole local platform and disposable AWS wiring

**Files:**
- Modify Terraform/Helm/Argo manifests, connector registration, runtime secrets, dashboards/alerts and preflight gates
- Modify `docs/READ_SCALING.md`, `docs/runbooks/tenant-shard-move.md`, Stage 11/12/13 evidence, and deployment instructions
- Test: complete local Compose gate, image/config render, Terraform plan validation only (no apply), Helm/Argo static gates, CodeRabbit reviews

- [ ] Run end-to-end local web/API tests for sign-in, tenant data, new reading, latest/history query, live refresh, alert acknowledgement, tenant movement and post-move reads.
- [ ] Run mobile-config tests for issuer/API configuration, PKCE callback, reconnect and queued action behavior against the local/staging-compatible endpoints.
- [ ] Run load/fault tests for projection watermark serialization, replica lag, per-shard connection budget, Kafka backlog, Redis failure, shard failure, drain timeout and recovery.
- [ ] Fix all CodeRabbit request-changes findings and rerun on the complete implementation diff.
- [ ] Run `make verify`, relevant database integration suites, coverage gate, full Compose smoke, Terraform fmt/validate, Helm lint/render and deployment gates; save immutable evidence.
- [ ] Keep AWS live acceptance explicitly pending until credentials, region, DNS/HTTPS and authorized disposable account inputs exist; never run `terraform apply` in this plan.
- [ ] Update Stage 11/12/13 status only with linked executable evidence and retain teardown inventory gaps as blockers until proven.

## Handoff

This plan is intended for subagent-driven execution because service routing,
transaction fences, CDC, cache consistency and migration receipts are tightly
coupled and a defect can cause tenant data loss or cross-tenant access. Execute
one task at a time with a fresh implementer and independent review, integrating
each completed slice before starting its dependents.
