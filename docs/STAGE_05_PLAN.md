# Stage 05 plan: CQRS read models, history, search and replay

Status: **PLAN — not implemented.** Written 2026-09-24 against the working tree
(uncommitted Stage 04 work present). Nothing here marks any stage complete; only
evidence under `evidence/` linked from [MILESTONES.md](MILESTONES.md) does that.

Items marked **DECIDED** cite the document that decides them. Items marked
**OPEN DECISION** need the owner; each carries a recommendation. Line numbers refer
to the files as read on 2026-09-24.

## 0. Sources relied on

| Source | What it fixes for Stage 05 |
| --- | --- |
| [IMPLEMENTATION_BACKLOG.md](IMPLEMENTATION_BACKLOG.md) Stage 05 row | Deliverable: CQRS dashboard/site/alert projections, separate read DB, Cassandra history, Elasticsearch indexing, replay tooling. Depends on 04. Gate: "Rebuild from retained source matches reference state; tenant reads isolated; freshness visible; Cassandra retention/index failures tested" |
| [FIRST_VERTICAL_SLICE.md](FIRST_VERTICAL_SLICE.md) §2 l.31 | `projection-builder` (Go) owns `greenguard_read`: `consumer_inbox`, `device_views`, `reading_history`, `device_latest`, `projection_notifications`; owns read migrations |
| same, §3 l.95–109 | Topics, keys; one raw partition; aggregate order only via key |
| same, §4 l.216–232 | Read-DB table shapes, latest rule `(observed_at, stream_version)`, gap rule, inventory-after-telemetry rule, RLS/pooling rules |
| same, §5C l.305–312 | Projection transaction order, duplicate/collision handling, bounded retry, quarantine, one handler per partition |
| same, §5D l.314–353 | BFF query rules, `ProjectionFreshness` proposed fields |
| same, §6 l.365–379; §7 l.405–414 | Crash rows; tests P01–P06, Q01–Q04 |
| same, §8 l.429 | Stage 05 cut: reference projection first, then Cassandra/search as independent consumers |
| same, §10 l.459–461 | Retention/replay horizon; fallback relay is an explicit recovery mode |
| [PLATFORM_CONTRACTS_AND_OPERATIONS.md](PLATFORM_CONTRACTS_AND_OPERATIONS.md) §1, §3, §6 | Ownership table (projection-builder, cassandra-writer, search-indexer rows); facility events on `greenguard.inventory.facility.v1`; Stage 06a-0 added `lot.changed` on dedicated `greenguard.inventory.lot.v1`; local ports Cassandra 19042, Elasticsearch 19200, OpenSearch 29200 |
| [COVERAGE_MATRIX.md](COVERAGE_MATRIX.md) D07, D08, D16, M14, M15, X14, X17, Z09 | Acceptance rows owned by Stage 05 |
| [TECHNOLOGY_CATALOG.md](TECHNOLOGY_CATALOG.md) l.162, 169, 222, 228, 246 | Historical pins: `cassandra:4.1`, `elasticsearch:8.13.0`, `opensearchproject/opensearch:2.13/2.14`, `elasticsearch==8.13.0`, `opensearch-py>=2.6.0` |
| [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md) l.89–102 | Stage 04 review findings B1, H1–H7 |
| [CAPACITY_MODEL.md](CAPACITY_MODEL.md) l.10–64 | Tier 1 targets (UNMEASURED) |
| [ADR-0006](adr/0006-ingest-quality-and-lateness.md) l.31–38 | Lateness: 7-day max age; rollup allowed lateness 10 min; no streaming watermark |
| [ADR-0008](adr/0008-canonical-transformer.md) | Transformer design; one outstanding record per process |
| [ADR-0010](adr/0010-schema-registry-contract.md) | PROPOSED: plain JSON, six headers, local schema validation, Registry as CI gate only |
| `services/device-service/src/inventory/repository.ts` l.69–141 | `appendEvent` hardcodes `aggregateType: "device"` (l.77); `createSite` (l.116–125) and `createBin` (l.127–141) write only the row: no outbox, no audit |
| `services/cdc-transformer/event.go` l.36–44, 192–194 | Four event types allowlisted; anything non-telemetry routes to `greenguard.inventory.device.v1` |
| `scripts/kafka-topics.mjs` l.5–15 | Provisioned topics and partition counts (canonical: 6) |
| `services/telemetry-ingest/` (`consumer.go`, `consumer_kafka.go`, migration 000001 l.95–111) | Reusable consumer pattern: franz-go `Next`/quarantine seam, bounded retry, checkpoint, inbox DDL, forced-RLS loop |
| `contracts/events/*.schema.json` | Four existing schemas; telemetry payload fields `reading_id, device_id, site_id, bin_id, binding_version, source_message_id, observed_at, received_at, measurements` |

## 1. Scope and dependencies

### 1.1 In scope (Stage 05)

1. Facility events (review H6) so site/bin projections are possible.
2. `greenguard_read` database and the Go `projection-builder` service: inbox,
   `device_views`, `site_views`, `bin_views`, `reading_history`, `device_latest`,
   stream gap tracking, projection freshness, `projection_notifications`.
3. Replay tooling and the rebuild-from-retained-source proof (P05, P06; D07, D08, X14).
4. `cassandra-writer`: time-bucketed history with TTL/retention and failure tests (D16).
5. `search-indexer`: tenant-safe index, bulk errors, alias reindex (M14).
6. A tenant-scoped read access layer and contract for the Stage 08 BFF (not the BFF).
7. Rollup windows per ADR-0006 l.37 (X17) — only the minimal hourly device rollup;
   see OPEN DECISION D7.

### 1.2 Out of scope, moved elsewhere

| Item | Where | Why |
| --- | --- | --- |
| Alert projection ("alert projections" in the backlog Stage 05 row) | **Stage 06** | No alert events exist; `greenguard.alerts.lifecycle.v1` is owned by workflow-alerts (PLATFORM §3). Review H6 (ARCHITECTURE_REVIEW l.101) records the split. The backlog row itself is unchanged by this plan; the owner should amend it (D1) |
| Lot events (`lot.changed`, `lot.retired`) | **Stage 06** | Stage 06a-0 added lot ownership and `lot.changed` on a dedicated topic; empty-bin retirement remains open. |
| Tenant events (`greenguard.inventory.tenant.v1`) | Stage 09 | Control-plane extraction |
| GraphQL BFF, Redis pub-sub relay of notifications, dashboard | Stage 08 | FIRST_VERTICAL_SLICE §5D l.320 |
| OpenSearch adapter equivalence | Stage 10 (M15) | Coverage matrix l.70 |
| Tier 1 certification | Stage 13 | CAPACITY_MODEL l.3 |

### 1.3 Stage 04 items that must be verified before Stage 05 code merges

Stage 04 is "In progress" in [MILESTONES.md](MILESTONES.md). Found in the tree:

| # | Blocking item | State found | Needed before |
| --- | --- | --- | --- |
| S1 | Live `make events-e2e` passing and linked as evidence | `evidence/STAGE_04B_E2E.log` (648 B, 2026-09-23 23:43) contains 6 `PASS` lines (inventory→binding, poison quarantine, SIGKILL replay, heartbeat checkpoints, stale 503, freshness recovery). `evidence/STAGE_04B_VALIDATION.md` l.120 still says "The live script was not run here". Milestone not updated. The owner must reconcile the log with the validation file and link it | 05a merge |
| S2 | E03/E04/E05 live fault harness | `evidence/STAGE_04C_VALIDATION.md` header: "UNVERIFIED live behavior" | 05b (replay relies on connector/broker recovery) |
| S3 | ADR-0010 approval (review H4) | Status PROPOSED (adr/0010 l.3). Registration script and CI gate "pending" (l.29–31) | 05a consumer codec; facility topic registration |
| S4 | H5: telemetry `aggregate_id == payload.device_id` enforced in both validators with shared fixtures | Open (ARCHITECTURE_REVIEW l.100) | 05a: projection partition identity depends on it. The projection-builder also enforces it (defence in depth) |
| S5 | B1: transformer fails closed on expired/unavailable raw offset | "Being fixed… verification pending" (l.95) | 05b: replay horizon statements |
| S6 | H3: WAL retention limits and slot alerts | Open (l.98); 04c implemented guardrails, unverified | 05b retention/horizon table |
| S7 | Bounded recovery relay (backlog Stage 04 deliverable "bounded recovery relay") | No relay code found in `services/` or `scripts/`; FIRST_VERTICAL_SLICE §10 l.461 describes it as an explicit recovery mode. **OPEN DECISION D2** | 05b only if replay depends on it; recommend decoupling (see D2) |
| S8 | H2 replication-role privilege boundary | Open | Not blocking Stage 05 locally; blocking Stage 12 |
| S9 | Stage 03b remote CI | "Remote CI for 03b pending" (MILESTONES) | Hygiene; not a design blocker |

Rule: 05a may be **developed** in parallel with S1–S6 closing, but may not be
**merged or marked complete** until S1, S3 and S4 are closed with evidence.

### 1.4 Stage 05 prerequisite: facility events (H6)

Verified: `createSite` and `createBin` (repository.ts l.116–141) write no outbox or
audit row; `appendEvent` (l.69–108) hardcodes `aggregateType: "device"` and
`resourceType: "device"`. The transformer allowlist (event.go l.36–39) and routing
(l.192–194) know only device and telemetry types. The inventory connector already
captures the whole `outbox_events` table into `greenguard.raw.inventory.outbox`, so
no connector change is needed.

**DECIDED names** (PLATFORM §3 facility row): topic `greenguard.inventory.facility.v1`,
event types `site.changed` and `bin.changed`. A create is `site.changed` with
aggregate version `1`.

Required changes, each in the same transaction as the domain write (invariant 3):

| Change | File(s) | Detail |
| --- | --- | --- |
| Add `version bigint NOT NULL DEFAULT 1` to `sites` and `bins` | new Prisma migration in `services/device-service/prisma/migrations/` | Optimistic concurrency for future edits (ADR-0002 low-contention rule). Document in migration header |
| Generalise `appendEvent` | `inventory/repository.ts` | `aggregateType`/`resourceType` from `EventSpec` (`device`, `site`, `bin`); rename `deviceId` to `aggregateId`; keep `binding_version` payload only for device events |
| Site/bin create writes row + outbox + audit + command receipt | same, plus controller | Needs an `Idempotency-Key` on `POST /v1/sites` and `/v1/bins` like device register (**OPEN DECISION D3**: recommend yes; the API already accepts the header for devices) |
| Two schemas | `contracts/events/site-changed.v1.schema.json`, `bin-changed.v1.schema.json` + fixtures | Envelope identical to `device-registered.v1` (12 required fields, `additionalProperties:false`) |
| TS types/validators | `packages/contracts/src/index.ts` + test | Same pattern as existing inventory events |
| Transformer allowlist + routing | `services/cdc-transformer/event.go`, `schema.go`, tests | `typeSiteChanged`, `typeBinChanged` → `topicFacility`; default branch must become an explicit allowlist switch that quarantines unknown types rather than falling through to the device topic |
| Topic | `scripts/kafka-topics.mjs` | `["greenguard.inventory.facility.v1", 6]` (OPEN DECISION D4 on partitions; recommend 6 for uniformity) |
| Registry subject | ADR-0010 registration script | `greenguard.inventory.facility.v1-value` as a union of the two schemas (ADR-0010 l.36–38) |

Payload sketch (decimal-string versions as elsewhere):

```json
// site.changed v1, aggregate_type "site", aggregate_id = site_id
{ "site_id": "uuid", "name": "string", "site_version": "1" }
// bin.changed v1, aggregate_type "bin", aggregate_id = bin_id
{ "bin_id": "uuid", "site_id": "uuid", "name": "string", "bin_version": "1" }
```

Key: `tenant_id:aggregate_id` (ADR-0010 l.20). Telemetry's binding consumer must
ignore the facility topic (it does not subscribe; no change).

Tests: D-series additions in device-service — site/bin create writes exactly one
outbox and one audit row; rollback on outbox failure leaves no site; cross-tenant
site/bin FK still rejected; idempotent retry returns the same event ID.

## 2. Slices

Each slice ends with a green gate (`make verify` + 100% coverage + Sonar gate,
per CLAUDE.md) and one evidence file. Live-stack targets are separate and never
part of `make verify`.

| Slice | Deliverable | Depends on | Evidence file |
| --- | --- | --- | --- |
| 05a | Facility events; `greenguard_read`; projection-builder (inbox, device/site/bin views, history, latest, gaps, freshness, notifications) | S1, S3, S4; 1.4 | `evidence/STAGE_05A_VALIDATION.md` |
| 05b | Replay/rebuild tooling; P05/P06; projection versioning and swap | 05a; S2, S5, S6 | `evidence/STAGE_05B_VALIDATION.md` |
| 05c | cassandra-writer, TTL/retention, failure tests | 05a contract only (independent consumer) | `evidence/STAGE_05C_VALIDATION.md` |
| 05d | search-indexer | 05a facility events | `evidence/STAGE_05D_VALIDATION.md` |
| 05e | Tenant-scoped read access package + contract for BFF | 05a schema | `evidence/STAGE_05E_VALIDATION.md` |

### 2.1 Slice 05a — read DB and projection-builder

#### Database and roles

- Logical DB `greenguard_read`, created in `infra/compose/init-databases.sql`
  alongside the existing two (FIRST_VERTICAL_SLICE §2: "first slice has only
  inventory, telemetry and read logical databases").
- Roles (mirroring telemetry): `read_migrator` (owner, migrations only),
  `projection_app` (runtime writer: SELECT/INSERT/UPDATE on projection tables, no
  DELETE except on its own versioned rebuild tables, not owner, no BYPASSRLS),
  `read_query` (BFF: SELECT only on views listed in 05e). PgBouncer entry for
  `greenguard_read` with transaction pooling.
- Migrations: Go `golang-migrate`-style numbered SQL under
  `services/projection-builder/migrations/`, same runner pattern as
  `services/telemetry-ingest/migrations/migrate.go`. Forward-only (review O5).

#### DDL sketch (design, not installed)

All tenant tables: `tenant_id uuid NOT NULL`, forced RLS with the telemetry policy
text (000001 l.111: `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`
for USING and WITH CHECK), composite tenant keys.

```sql
CREATE TABLE consumer_inbox (            -- same shape as telemetry 000001 l.95
  consumer_name text NOT NULL, tenant_id uuid NOT NULL, event_id uuid NOT NULL,
  source_topic text NOT NULL, source_partition int NOT NULL, source_offset bigint NOT NULL,
  event jsonb NOT NULL, processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer_name, tenant_id, event_id));

CREATE TABLE site_views (
  tenant_id uuid, site_id uuid, name text NOT NULL, site_version bigint NOT NULL,
  updated_at timestamptz NOT NULL, PRIMARY KEY (tenant_id, site_id));

CREATE TABLE bin_views (
  tenant_id uuid, bin_id uuid, site_id uuid NOT NULL, name text NOT NULL,
  bin_version bigint NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, bin_id));
  -- no FK to site_views: topics are independent and may arrive out of order

CREATE TABLE device_views (             -- FIRST_VERTICAL_SLICE l.219
  tenant_id uuid, device_id uuid, site_id uuid NOT NULL, bin_id uuid,
  serial_number text NOT NULL, status text NOT NULL,
  inventory_version bigint NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id));

CREATE TABLE reading_history (          -- FIRST_VERTICAL_SLICE l.220
  tenant_id uuid, reading_id uuid, device_id uuid NOT NULL, event_id uuid NOT NULL,
  stream_version bigint NOT NULL, source_message_id text NOT NULL,
  site_id uuid NOT NULL, bin_id uuid, observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL, temperature_c double precision,
  relative_humidity_percent double precision,
  inventory_enrichment text NOT NULL CHECK (inventory_enrichment IN ('pending','applied')),
  projected_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, reading_id),
  UNIQUE (tenant_id, event_id), UNIQUE (tenant_id, device_id, stream_version));
-- index for history queries: (tenant_id, device_id, observed_at DESC, stream_version DESC)

CREATE TABLE device_latest (            -- FIRST_VERTICAL_SLICE l.221
  tenant_id uuid, device_id uuid, reading_id uuid NOT NULL, event_id uuid NOT NULL,
  selected_observed_at timestamptz NOT NULL, selected_stream_version bigint NOT NULL,
  max_seen_stream_version bigint NOT NULL,
  contiguous_through_version bigint NOT NULL,      -- gap tracking, see below
  projected_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id),
  FOREIGN KEY (tenant_id, reading_id) REFERENCES reading_history (tenant_id, reading_id));

CREATE TABLE stream_gaps (              -- open version ranges per device
  tenant_id uuid, device_id uuid, from_version bigint, to_version bigint NOT NULL,
  detected_at timestamptz NOT NULL, PRIMARY KEY (tenant_id, device_id, from_version),
  CHECK (from_version <= to_version));

CREATE TABLE projection_notifications ( -- FIRST_VERTICAL_SLICE l.222
  notification_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, resource_type text NOT NULL,
  resource_id uuid NOT NULL, event_id uuid NOT NULL, purpose text NOT NULL,
  created_at timestamptz NOT NULL, delivered_at timestamptz,
  UNIQUE (tenant_id, event_id, purpose));

CREATE TABLE projection_checkpoints (   -- freshness; one row per consumer/topic/partition
  consumer_name text, topic text, partition int, committed_offset bigint NOT NULL,
  last_event_occurred_at timestamptz, last_projected_at timestamptz NOT NULL,
  PRIMARY KEY (consumer_name, topic, partition));
-- NOT tenant-scoped (transport metadata, no tenant data); no RLS; written only by
-- projection_app; never exposed to read_query. Same reasoning as telemetry's
-- binding_feed_checkpoints (migration 000004).
```

`device_latest.reading_id` FK is composite and tenant-aware; `reading_history`
keeps event-carried `site_id`/`bin_id` (l.226: later inventory events must not
erase historical binding metadata).

#### Concurrency choice per table (invariant 6; document in migration header)

| Table | Contention | Choice |
| --- | --- | --- |
| `consumer_inbox` | Duplicate delivery of one event | Unique PK + `INSERT … ON CONFLICT DO NOTHING RETURNING` (FIRST_VERTICAL_SLICE l.308) |
| `reading_history` | None beyond duplicates | Unique constraints; insert-only |
| `device_latest`, `stream_gaps` | Same device from one partition (single handler) plus replay/rebuild writers | **Pessimistic**: `SELECT … FOR UPDATE` on the `device_latest` row (insert-if-absent first with `ON CONFLICT DO NOTHING`), bounded by `SET LOCAL lock_timeout = '2s'`. Lock order: inbox → device_latest → stream_gaps. ADR-0002 "hot single-row contention" |
| `device_views`, `site_views`, `bin_views` | Out-of-order versions | **Version-guarded upsert**: `INSERT … ON CONFLICT (…) DO UPDATE … WHERE excluded.<x>_version > <table>.<x>_version`. Older version is a recorded no-op, not an error |
| `projection_notifications` | None | Unique `(tenant_id, event_id, purpose)` |
| `projection_checkpoints` | One owner per partition via group assignment | Plain upsert in the same transaction as the effect |

#### Topics, group, offsets

- Consumer group `greenguard.projection-builder.v1`; subscribes to
  `greenguard.inventory.device.v1`, `greenguard.inventory.facility.v1`,
  `greenguard.telemetry.recorded.v1`. Separate group name per projection version
  (05b).
- Client: franz-go (already pinned `v1.22.0` in telemetry and transformer go.mod),
  auto-commit off, `kfake` for unit tests.
- Per record: validate → BEGIN → `set_config('app.tenant_id', $1, true)` → inbox →
  effect → notification → checkpoint row → COMMIT → commit offset. One outstanding
  record per partition (FIRST_VERTICAL_SLICE l.312). Offsets committed only for the
  contiguous frontier (l.303; P05).
- Ordering: per aggregate only, by key `tenant_id:aggregate_id`. No cross-topic
  ordering assumed: device/facility/telemetry for one device may arrive in any order.

#### Event → table mapping

| Event | Tables | Rule |
| --- | --- | --- |
| `device.registered` | `device_views` insert-or-upgrade | version guard on `inventory_version` (= payload `binding_version`) |
| `device.binding_changed` | `device_views` site/bin/version | version guard; does **not** rewrite `reading_history` |
| `device.status_changed` | `device_views.status` | version guard |
| `site.changed` | `site_views` | version guard on `site_version` |
| `bin.changed` | `bin_views` | version guard on `bin_version` |
| `telemetry.recorded` | `reading_history` insert; `device_latest` select-newer; `stream_gaps`; `projection_notifications` | Latest = max `(observed_at, stream_version)` (l.224); nullable measurements preserved; `inventory_enrichment='pending'` if no `device_views` row exists at insert time, else `'applied'`. A later `device.registered` flips pending rows for that device to applied (metadata unchanged) |
| any accepted event | `consumer_inbox`, `projection_checkpoints` | — |

Note: the current device event names in code (`device.status_changed`) differ from
PLATFORM §3 (`device.disabled`). Code and `contracts/events/` win; PLATFORM should
be corrected by the owner (flagged, not changed here).

#### Gap handling (P03)

- `max_seen_stream_version = greatest(existing, v)`.
- If `v > max_seen + 1`: insert gap `[max_seen+1, v-1]`.
- If `v` falls inside an open gap: split/shrink it.
- `contiguous_through_version` = highest `n` with no open gap ≤ `n` (starts at 0,
  first telemetry stream version is 1 per telemetry-ingest).
- `hasKnownGap = EXISTS(stream_gaps for device)`. Never infer completeness from
  `max_seen` (l.224, ADR-0006 l.38).

#### Duplicate, collision and contract mismatch (P02, ADR-0010)

| Case | Action |
| --- | --- |
| Inbox conflict, stored `event` semantically equal (JSONB equality, so key order/whitespace irrelevant) | ROLLBACK the no-op txn, commit offset, count `projection_duplicates_total` |
| Inbox conflict, different content | ROLLBACK, publish to `greenguard.quarantine.v1` with source coordinates, wait for ack, then commit offset; count `projection_collisions_total`; error log with tenant/event |
| Unknown `event_type`/`schema_version`, schema failure, header ≠ envelope, key tenant/aggregate ≠ envelope, telemetry `aggregate_id ≠ payload.device_id` (H5) | Confirmed quarantine before offset commit (ADR-0010 l.51–55). Tenant in quarantine record only if validated (ADR-0008 "Quarantine tenant handling") |
| Quarantine publish fails | Do not commit; pause partition; readiness degraded; bounded retry (reuse `retry` shape from `telemetry-ingest/consumer.go` l.169) |
| Transient DB error / deadlock / lock timeout | ROLLBACK; bounded exponential retry; on exhaustion either keep the offset (pause) or quarantine. **DECIDED** by l.311: never skip |
| Schema drift (strict `additionalProperties:false` rejects added field) | Quarantine + alert; resolution is consumer-first rollout (ADR-0010 l.59–70) |

#### Freshness (Q02 input; backlog "freshness visible")

- Per device: `device_latest.projected_at`, `max_seen_stream_version`,
  `hasKnownGap` → `ProjectionFreshness` (FIRST_VERTICAL_SLICE l.346–350).
- Per partition: `projection_checkpoints` + metrics
  `projection_lag_records{topic,partition}`, `projection_last_projected_age_seconds`,
  `projection_event_to_projection_seconds` histogram (occurred_at → commit). No
  tenant/device labels (ADR-0006 l.29 rule).
- Tracing via `@greenguard/otel` equivalents in Go (telemetry `tracing.go`):
  continue the event `traceparent`; never invent IDs (ADR-0004).

#### Notifications

`projection_notifications` rows are written in the effect transaction. No relay
exists in Stage 05; Stage 08 builds the Redis relay (l.320). Retention: delete
delivered rows older than 7 days via an owner-run job — **OPEN DECISION D8**
(undelivered rows grow until Stage 08; recommend a bounded cap + metric).

#### Service layout

`services/projection-builder/`: own Go module, `main.go` with `run(ctx, getenv)`
(CLAUDE.md), `config.go`, `consumer_kafka.go`, `processor.go`, `schema.go`
(embedded `contracts/events` schemas, compiled at startup per ADR-0010 l.40–44),
`store.go`, `migrations/`, `Dockerfile`, `README.md`, `CLAUDE.md`. Add to
`sonar-project.properties`, `scripts/coverage.mjs`, CI (services/CLAUDE.md).

**OPEN DECISION D5**: extract a shared Go package (`packages/go-consumer`) for the
franz-go seam/retry/quarantine now vs copy. Recommend **copy for 05a**, extract once
three consumers exist (projection, cassandra, transformer) — avoids editing
telemetry-ingest while other agents work on it.

#### 05a gate

`make verify` green at 100%; P01–P04 automated; tenant isolation test; `make
projection-e2e` live run (committed reading → queryable `device_latest` within the
test's bound) archived in `evidence/STAGE_05A_VALIDATION.md` with offsets/counts.

### 2.2 Slice 05b — replay and rebuild (P05, P06, D07, D08, X14)

**Retained source.** Kafka canonical topics are the replay source within their
retention; beyond that, the owning outbox tables (FIRST_VERTICAL_SLICE l.459).
**OPEN DECISION D6**: canonical-topic retention for the local/CI profile and the
supported replay horizon. Recommend: canonical topics `retention.ms=-1` locally
(small data), 7 days in staging; read-side inbox retention ≥ that horizon; replay
older than the horizon uses an outbox re-publish procedure that preserves IDs (this
is where D2's relay would live). State the horizon in a table in the service README.

**Versioned projections.** Rebuild writes into schema `read_v<N>` (same DDL) with
consumer group `greenguard.projection-builder.v<N>` from offset `earliest`. Live
readers use views in schema `read` (`CREATE VIEW read.device_latest AS SELECT … FROM
read_v<N>.device_latest`). Switch = one transaction replacing the views after
validation (X14 "shadow projection… swaps atomically"). Old version kept until the
owner drops it. **Never truncate the live inbox** (X14).

**Tooling** (`services/projection-builder/cmd/replay`): subcommands
`rebuild --version N`, `status --version N` (per-partition offset vs high watermark,
gaps), `compare --from N --to M` (sorted semantic row dump + counts per tenant,
latest selections), `swap --to N` (refuses unless compare is clean and lag is 0 at a
recorded frontier), `--dry-run` everywhere (X27). Replay preserves event IDs
(FIRST_VERTICAL_SLICE l.379).

**Reference state.** `compare` checks the rebuilt version against the live version
and against an independent reference computed from the canonical topic by a pure Go
function (fold over events with the same latest/gap rules), so a shared bug in the
SQL path cannot pass both.

**05b gate:** P05 (with real broker group offsets after restart) and P06 green;
live `make projection-replay` rebuilds, compares zero diff, swaps, and a new
reading appears in the swapped version.

### 2.3 Slice 05c — Cassandra history (D16)

- Service `services/cassandra-writer` (Go, per its README), consumer group
  `greenguard.cassandra-writer.v1`, subscribes to `greenguard.telemetry.recorded.v1`
  only. Independent of projection-builder (l.429).
- Driver: **OPEN DECISION D9** — `gocql` vs `apache/cassandra-gocql-driver`
  (the project moved to Apache). Recommend the Apache module at a pinned tag; add
  to TECHNOLOGY_CATALOG as a new technology family.
- Keyspace `greenguard_history`, local RF1 (labelled non-HA), `NetworkTopologyStrategy`.

```cql
CREATE TABLE readings_by_device_day (
  tenant_id uuid, device_id uuid, day date,          -- UTC day of observed_at
  observed_at timestamp, stream_version bigint,
  reading_id uuid, event_id uuid, site_id uuid, bin_id uuid,
  received_at timestamp, temperature_c double, relative_humidity_percent double,
  PRIMARY KEY ((tenant_id, device_id, day), observed_at, stream_version)
) WITH CLUSTERING ORDER BY (observed_at DESC, stream_version DESC)
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS','compaction_window_size':1}
  AND default_time_to_live = <retention>;
```

- Partition size: Tier 1 rate is one reading per 50 s per device (CAPACITY_MODEL
  l.16) = 1,728 rows/day ≈ 0.4–1 MB per partition at ≤2 KB/event before
  compression — well under the usual 100 MB guidance. A `(tenant, device, day)`
  bucket keeps one hot device from forming an unbounded partition. UNMEASURED.
- Idempotency: the primary key is deterministic from the event, so re-delivery is
  an overwrite of identical values (Cassandra upsert). No LWT on the hot path. A
  duplicate event ID with different content cannot be detected by upsert alone;
  **OPEN DECISION D10**: recommend a small `events_seen(tenant_id, event_id) →
  digest` table written first with `IF NOT EXISTS` only in a sampled/audit mode,
  and rely on projection-builder's inbox for authoritative collision detection.
- Late events: written to their observed day's bucket; TTL counted from write time
  means a late reading lives longer than its neighbours — **DECIDED consequence,
  documented**; retention is "at least N days".
- Offsets: commit after the write reaches the chosen consistency (`LOCAL_QUORUM`,
  = ONE on RF1). Failure: no commit, bounded retry, pause; poison → quarantine.
- Tenant isolation: Cassandra has no RLS. Every query path requires `tenant_id` in
  the partition key (compile-time: query builder only accepts `(tenant, device,
  day)`); dedicated app role with keyspace-only grants. Tenant filtering is
  application-level only — record this as a known weaker layer in the README.
- Rollups (X17, ADR-0006 l.37): **OPEN DECISION D7** — Postgres or Cassandra.
  Recommend a Postgres `device_hourly_rollup` in projection-builder in 05b (window
  closes at watermark + 10 min; late reading triggers recompute; test that
  recompute = incremental), keeping Cassandra raw-only in Stage 05.

**05c gate:** unit tests with a fake session; live `make history-test`: write,
read by bucket, TTL expiry with a short test TTL, node stop → consumer pauses and
offset does not advance → node back → catch-up with no loss; oversized-row / bad
event → quarantine.

### 2.4 Slice 05d — search indexer (M14)

**OPEN DECISION D11: Elasticsearch vs OpenSearch for the Stage 05 profile.**
Coverage says M14 (Elasticsearch + Kibana) is Stage 05 and M15 (OpenSearch) is
Stage 10 (COVERAGE_MATRIX l.69–70); the search-indexer README says "Elasticsearch/
OpenSearch". Reasoning:

- Licensing: OpenSearch is Apache-2.0. Elasticsearch 8.x source is under
  SSPL/Elastic License, with AGPLv3 added as an option from 8.16 — the owner must
  confirm which licence is acceptable for a SaaS product. (Stated from general
  knowledge; verify against the vendor licence page before deciding.)
- Ops: both run single-node locally; both need ~1 GB heap minimum. OpenSearch has
  no security-off-by-default trap but requires an admin password env var from 2.12.
- Plan fit: coverage matrix already assigns ES to 05 and OpenSearch to 10, and the
  historical GrainGuard source used ES 8.13.

**Recommendation:** follow the coverage matrix — Elasticsearch in 05d behind an
adapter interface with a contract suite, OpenSearch reuses the suite in Stage 10 —
**unless** the owner rejects the Elastic licence for production, in which case swap
the order (OpenSearch first) and amend M14/M15. Either way the index contract
below is engine-neutral.

- Service: `services/search-indexer` (Python asyncio per README; **OPEN DECISION
  D12**: recommend keeping Python so the Python toolchain in CI is exercised; the
  alternative is Go for consumer-pattern reuse). Kafka client `confluent-kafka` or
  `aiokafka`, pinned.
- Group `greenguard.search-indexer.v1`; subscribes to device and facility topics
  (not telemetry: search is over inventory, not readings).
- Index `greenguard-inventory-v<N>` with alias `greenguard-inventory`; document ID
  `tenant_id:resource_type:resource_id`; `tenant_id` keyword field; external
  versioning (`version_type=external`, version = aggregate version) so older
  events are rejected by the engine (idempotent, order-safe).
- Tenant rule: every query goes through one function that adds a `term` filter on
  `tenant_id`; a test asserts no other query path exists. Filtered aliases per
  tenant are **not** used (10M tenants).
- Bulk: per-item result inspection; version-conflict (409) = success no-op; other
  item errors → quarantine that item, retry transient ones; commit offset only when
  every item in the batch is indexed or quarantined (contiguous frontier).
- Delete propagation: no delete events exist yet; `device.status_changed` updates
  status only. Documented gap until tenant deletion (review O2).
- Reindex: new `-v<N+1>` index from earliest offsets under a new group; compare
  counts per tenant against `device_views`/`site_views`/`bin_views`; atomic alias
  swap.

**05d gate:** unit tests (fake client) at 100%; live `make search-test`: index,
tenant-filtered query denies cross-tenant, bulk partial failure, zero-loss reindex
+ alias swap.

### 2.5 Slice 05e — read access layer for the BFF

- `packages/read-model` (TypeScript, for the Apollo BFF in Stage 08): a
  `withReadTenant(db, tenantId, fn)` helper that sets `app.tenant_id` with
  `set_config(..., true)` inside a transaction on the `read_query` role, plus
  typed queries: `getDevice`, `getLatestReading`, `getReading`, `listDevicesBySite`,
  `listReadings(deviceId, from, to, limit)`, `getFreshness`. Every query also
  filters `tenant_id` explicitly (AGENTS rule 1).
- `contracts/graphql/read.v1.graphql` recording the proposed types from
  FIRST_VERTICAL_SLICE l.325–351 plus `SiteView`, `BinView`; marked proposed until
  Stage 08.
- Foreign IDs return the same "not found" as absent IDs (l.317).

**05e gate:** tests for each query with two tenants (foreign ID → null), missing
tenant → zero rows, `read_query` cannot INSERT/UPDATE or read
`projection_checkpoints`.

## 3. Test plan

Automated tests run in `make verify` (DB-backed ones use the existing Postgres,
as telemetry does). Live-stack scripts are separate Make targets.

### 3.1 Mapping to design test IDs

| ID | Slice | Automated tests (proposed names) | Live script |
| --- | --- | --- | --- |
| P01 inbox atomicity | 05a | `TestP01CrashBeforeInboxCommitLeavesNothing`, `…AfterInboxBeforeHistory`, `…AfterCommitBeforeOffset` (fault hooks in store; redelivery → exactly one history/notification row) | `projection-e2e`: SIGKILL between COMMIT and offset commit, restart, count = 1 |
| P02 duplicate/collision | 05a | `TestP02ReorderedJSONKeysIsDuplicate`, `TestP02SameIDDifferentContentQuarantines` | — |
| P03 reorder + missing | 05a | `TestP03Versions42_40_41` (history complete, latest deterministic, gap opened then closed, `contiguous_through` correct) | — |
| P04 same timestamp | 05a | `TestP04IdenticalObservedAtKeepsTwoRowsTieBreakByVersion` | — |
| P05 offset frontier | 05a (kfake), 05b (real broker) | `TestP05HigherOffsetDoneLowerPendingDoesNotCommit` (kfake) | `projection-replay`: fail low offset, finish higher, restart, assert group offset from broker |
| P06 replay | 05b | `TestP06RebuildEqualsReferenceFold` | `projection-replay`: rebuild vN, compare, swap |
| Q01 (read part) | 05e | foreign tenant ID → null; DataLoader not in scope (Stage 08) | — |
| Q02 freshness | 05a/05e | `TestFreshnessPendingThenProjected`, `TestOlderObservedDoesNotReplaceLatest` | `projection-e2e` asserts 202 → pending, later visible |
| Q03, Q04 | Stage 08 | — | — |
| Crash row l.376 inventory after telemetry | 05a | `TestTelemetryBeforeDeviceViewStoresPendingEnrichment` then device event → applied, metadata unchanged | — |
| H5 identity | 05a | `TestTelemetryAggregateDeviceMismatchQuarantines` | — |

### 3.2 Backlog acceptance clauses

| Clause | Proof |
| --- | --- |
| Rebuild from retained source matches reference state | P06 + `compare` zero-diff output archived in 05b evidence; reference fold independent of SQL |
| Tenant reads isolated | RLS tests per table (runtime role with tenant A sees 0 rows of B; missing tenant → 0 rows; `read_query` cannot bypass); 05e foreign-ID tests; Cassandra query-builder test; search tenant-filter test |
| Freshness visible | `ProjectionFreshness` query tests; `/metrics` exact-text test for lag/age metrics (pattern: telemetry `TestMetricsExactText`) |
| Cassandra retention/index failures tested | 05c: TTL expiry, node-down pause, restart catch-up; 05d: bulk partial failure, mapping conflict → quarantine, reindex. ("index failures" read as both Cassandra and search index failures) |

### 3.3 Live targets (kept out of `make verify`, like `events-e2e`)

| Target | Needs | Script |
| --- | --- | --- |
| `make projection-e2e` | base + events overlay | `scripts/projection-e2e.mjs` |
| `make projection-replay` | same | `scripts/projection-replay.mjs` |
| `make history-up/test/down` | + timeseries overlay | `scripts/history-test.mjs` |
| `make search-up/test/down` | + search overlay | `scripts/search-test.mjs` |

## 4. Infrastructure

- New overlays, opt-in like `infra/kafka/compose.yaml` (EVENTS_INFRA: base
  `db-up/dev/verify/coverage/smoke` never load it):
  `infra/cassandra/compose.yaml` (profile `timeseries`),
  `infra/search/compose.yaml` (profile `search-elastic`; `search-opensearch` in
  Stage 10). projection-builder runs against the base Postgres + events overlay.
- Images **pinned by digest**, host ports bound to 127.0.0.1 per PLATFORM §6.
  Tags to resolve (latest patch at implementation time, then record digest and
  provenance as 04a did): `cassandra:4.1.x` or `5.0.x` (**OPEN DECISION D13**;
  recommend 5.0 for current support and SAI, verify driver compatibility),
  `docker.elastic.co/elasticsearch/elasticsearch:8.x` (or
  `opensearchproject/opensearch:2.x` per D11). Kibana optional, separate profile.
- Laptop memory budget (UNMEASURED; estimate): existing base + Kafka overlay
  ~3 GB; Cassandra `MAX_HEAP_SIZE=512M HEAP_NEWSIZE=128M`, container limit 1.5 GB;
  Elasticsearch `ES_JAVA_OPTS=-Xms512m -Xmx512m`, limit 1.5 GB, single-node,
  `discovery.type=single-node`. Full stack ≈ 6 GB; overlays must be runnable one
  at a time.
- CI: new separate jobs, not steps in `quality` (ci.yml jobs today: `quality`,
  `publish`, `events-integration`): `projection-integration` (events overlay +
  `projection-e2e` + `projection-replay`), `history-integration`,
  `search-integration`. Each required in the final gate once green (backlog
  defect list: "required CI jobs missing from final gate").
- Topic changes: `greenguard.inventory.facility.v1` added to `kafka-topics.mjs`
  (drift check already refuses changes to existing topics).

## 5. Capacity (all UNMEASURED; certification is Stage 13)

- Tier 1: 20k/s normal, 50k/s peak, p95 commit→projection < 1 s (CAPACITY_MODEL
  l.16–20).
- Canonical telemetry has 6 partitions (kafka-topics.mjs l.8). The Tier 1 target
  implies 3,333/s normal and 8,333/s peak per partition if evenly distributed
  (CAPACITY_MODEL l.55–56); skew makes the hottest partition the governing case.
  The planned optimization is a **batch of records from one partition** applied
  in one transaction (inbox multi-row insert, history `COPY`/multi-row insert,
  per-device latest computed in memory then one upsert per device), followed by
  commit of the contiguous frontier. This is **not implemented in the current
  code**: `packages/kafka-transport/transport.go` polls one record at a time and
  `projection-builder` applies one record per transaction; there is no batch-size
  flag. Treat batch size 1 as current behavior, not as a configurable batch
  implementation. Add and benchmark the batch path in Stage 13 before changing
  defaults. The historical 1–2 ms per-record transaction estimate makes the
  target implausible for one sequential handler, but must be measured on the
  end-to-end pipeline;
  - does **not** change partition count in Stage 05 (changing it rehashes keys and
    breaks per-aggregate order for in-flight data; that is Stage 13 work with a
    migration plan). **OPEN DECISION D4** records the target (recommend planning
    for 24–48 partitions at Tier 1, decided on measurement).
- Postgres write amplification per telemetry event in `greenguard_read`: inbox row
  (with full JSONB event) + history row + 3 history indexes (PK, 2 uniques, plus the
  query index) + `device_latest` update + notification row + checkpoint update ≈ 5
  row writes and ~7 index entries. At 20k/s ≈ 100k row writes/s, before WAL. This
  exceeds CAPACITY_MODEL's "40k/100k row effects/s" assumption (l.56) — flag to the
  owner. Mitigations to measure: store an event digest instead of full JSONB in the
  inbox once the canonical digest is verified (l.218 allows it); drop
  `UNIQUE(tenant_id,event_id)` on history if inbox already guarantees it (keep for
  now: invariant safety first); partition `reading_history` by time (monthly) with
  retention — **OPEN DECISION D14** on Postgres history retention (recommend 30
  days in Postgres, long-term in Cassandra).
- Cassandra: `(tenant_id, device_id, day)` bucket; hot tenants do not create hot
  partitions because the device is in the key; 20k/50k logical writes/s, 60k/150k
  replica writes at RF3 (CAPACITY_MODEL l.57).
- Search: telemetry excluded, so indexing load is inventory-rate only.
- Freshness budget: transformer leg is already the certified bottleneck concern
  (CAPACITY_MODEL l.53); projection p95 must fit what remains of 1 s.

## 6. Risks and open decisions (ordered by when they block)

| # | Decision / risk | Recommendation | Blocks |
| --- | --- | --- | --- |
| D1 | Backlog Stage 05 row still lists alert projections | Owner amends backlog: alert projection → Stage 06 (review H6) | Stage 05 exit wording |
| S3 | ADR-0010 not approved | Approve as written; build registration script before 05a merge | 05a |
| D3 | Idempotency-Key on site/bin create | Yes, same receipt pattern as device register | 1.4 |
| D5 | Shared Go consumer package now or later | Copy in 05a; extract after 05c | 05a |
| D8 | Undelivered notification growth before Stage 08 | Cap + metric + delete delivered >7 d | 05a |
| D4 | Facility partitions / telemetry partition growth | Facility 6 now; telemetry repartition is Stage 13 | 05a, 13 |
| D2 | Bounded recovery relay (Stage 04 deliverable) not built | Keep it a Stage 04 item; Stage 05 replay reads Kafka within retention and does not depend on the relay; document the horizon | 05b |
| D6 | Canonical retention / replay horizon | Infinite locally, 7 d staging; inbox retention ≥ horizon | 05b |
| D7 | Rollups in Postgres or Cassandra | Postgres hourly rollup in projection-builder | 05b |
| D14 | Postgres history retention | 30 d partitioned; Cassandra long-term | 05b |
| D9 | Cassandra Go driver | Apache gocql, pinned | 05c |
| D10 | Cassandra collision detection | Rely on projection inbox; optional sampled LWT check | 05c |
| D13 | Cassandra 4.1 vs 5.0 | 5.0 if driver-compatible | 05c |
| D11 | Elasticsearch vs OpenSearch | Follow coverage (ES in 05) unless licence rejected, then OpenSearch first | 05d |
| D12 | search-indexer language | Python (per README) | 05d |
| R-a | Capacity: per-record projection txn cannot reach Tier 1 per partition | Batch-capable processor from day one, default off | 13 |
| R-b | Amplification exceeds CAPACITY_MODEL assumption | Owner updates capacity model; measure in 13 | 13 |
| R-c | PLATFORM §3 names `device.disabled`; code has `device.status_changed` | Owner corrects PLATFORM | docs |
| R-d | Cassandra and search have app-level tenant filtering only | Single query entry point + tests; record in README | 05c/d |
| R-e | Transformer falls through unknown non-telemetry types to the device topic (event.go l.194) | Make routing an explicit allowlist in 1.4 | 1.4 |

## 7. Work breakdown and parallelism

Sequential spine:

1. **1.4 facility events** (device-service, contracts, packages/contracts,
   cdc-transformer, kafka-topics.mjs). Must precede 05a's facility handling and
   05d. Touches cdc-transformer and device-service — coordinate with any agent
   still editing Stage 04 code there.
2. **05a** projection-builder + read DB (after S1/S3/S4 for merge).
3. **05b** replay (needs 05a code).

Parallel once 05a's migrations are fixed (file sets are disjoint):

| Agent | Files it owns | Can start |
| --- | --- | --- |
| A: facility events | `services/device-service/**`, `contracts/events/site-*`, `bin-*`, `packages/contracts/**`, `services/cdc-transformer/event.go`/`schema.go`/tests, `scripts/kafka-topics.mjs` | now (after Stage 04 agents release those files) |
| B: projection-builder | `services/projection-builder/**`, `infra/compose/init-databases.sql` (read DB lines only), PgBouncer config entry | now, against fixtures; facility handler after A's schemas land |
| C: cassandra-writer | `services/cassandra-writer/**`, `infra/cassandra/**`, `scripts/history-test.mjs` | now (telemetry contract exists) |
| D: search-indexer | `services/search-indexer/**`, `infra/search/**`, `scripts/search-test.mjs` | after A's schemas; D11/D12 decided |
| E: read access | `packages/read-model/**`, `contracts/graphql/read.v1.graphql` | after B's migrations are merged |
| F: replay | `services/projection-builder/cmd/replay/**`, `scripts/projection-*.mjs` | after B |

Shared files that must be edited by **one agent at a time** (serialize or give to a
single integration pass at the end of each slice): `Makefile`,
`.github/workflows/ci.yml`, `sonar-project.properties`, `scripts/coverage.mjs`,
root `package.json`, `docs/TECHNOLOGY_CATALOG.md`, `docs/MILESTONES.md`,
`CLAUDE.md` stage table.

Before and after each slice: run the `architecture-guard` and
`tenant-isolation-reviewer` subagents and `coderabbit review` (CLAUDE.md).
