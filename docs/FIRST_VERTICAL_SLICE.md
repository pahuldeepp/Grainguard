# First vertical slice: one committed reading reaches one tenant's screen

**Status: proposed implementation design. No application in this slice has been implemented or run in the new GreenGuard project.** This document makes Stages 01–08 of [the backlog](IMPLEMENTATION_BACKLOG.md) concrete. The [blueprint](REBUILD_BLUEPRINT.md) remains the overall architecture. The original repositories stay preserved as evidence.

The first result is deliberately small: create a tenant, site and device; submit a temperature/humidity observation through the Go ingest boundary; atomically persist the reading and its outbox event; carry the event through Debezium, a canonical transformer and Kafka; atomically record a consumer receipt and update a read projection; query it through the authenticated BFF; show the reading and its freshness in the React dashboard. The result is complete only when failure and tenant-isolation tests pass, not when a graph of containers is running.

## 1. Invariants and definitions

- **Tenant**: the authorization and data-partition boundary. The server derives its ID from authenticated membership or device credentials. A body/header supplied by the caller cannot select an unrelated tenant.
- **Inventory aggregate**: a device and its site/bin assignment and lifecycle. `device-service` owns this state. Its `binding_version` advances when that assignment/lifecycle changes.
- **Telemetry stream aggregate**: the accepted observations for one tenant/device. `telemetry-ingest` owns its monotonically increasing `aggregate_version`. This sequence is independent of inventory `binding_version` and independent of the device clock.
- **Observation identity**: `(tenant_id, device_id, source_message_id)`. A device creates `source_message_id` before its first transmission and reuses it on every retry. A new HTTP retry ID does not mean a new reading.
- **Event identity**: a server-generated immutable `event_id` persisted once. Normal delivery, retry, replay and fallback publication preserve it. The same identity with changed semantic content is corruption, not a duplicate success.
- **Commit guarantee**: an acknowledged reading has a committed domain row, outbox row, request receipt and audit record in the **same owning PostgreSQL transaction**.
- **Delivery guarantee**: at-least-once event transport plus idempotent effects. PostgreSQL, Kafka and the screen do not participate in a distributed transaction.
- **Projection guarantee**: consumer receipt, history row, latest-view update and projection notification outbox are committed together before the source offset is committed.
- **Isolation guarantee**: every tenant-bearing row has a tenant key and enforced access policy; tenant-scoped aggregate keys/references, Kafka keys, queries, caches and subscription channels preserve it. Globally unique immutable event/notification UUID primary keys are an intentional exception to composite primary keys, not an exception to tenant columns, RLS or tenant-aware references.
- **Freshness guarantee**: “stored” and “projected” are distinct states. A 202 response does not assert that the BFF has already observed the event.

Outbox, inbox and audit correctness are part of the first slice. Billing, complex quotas, risk calibration, multiple delivery providers, long-term Cassandra/search projections and production HA are separate additions in the same master plan.

## 2. Concrete boundaries and ownership

Use one local PostgreSQL server initially, with **three logical databases and separate roles**. That makes the local setup understandable without allowing cross-service table writes. Each logical database needs its own logical-replication connector/slot if it publishes CDC.

| Owner | Database / tables | Allowed behavior |
|---|---|---|
| NestJS `device-service`, using Prisma | `greenguard_inventory`: `tenants`, `sites`, `bins`, `devices`, `command_receipts`, `outbox_events`, `audit_events` | Own tenant/site/device CRUD for the first slice. Identity-provider configuration and later tenancy boundary are explicit modules. Write inventory facts and inventory events in one transaction. |
| Go `telemetry-ingest`, using pgx | `greenguard_telemetry`: `device_bindings`, `device_streams`, `ingest_receipts`, `readings`, `outbox_events`, `audit_events`, `consumer_inbox` | Apply inventory binding events to local authorization/validation facts; accept observations and own their ordering/idempotency. Never update inventory tables. |
| Go `cdc-transformer` | No domain database writes; connector offsets live with Kafka Connect and consumer-group offsets with Kafka | Validate raw outbox CDC and publish the canonical event with unchanged identity. Never create a second reading/event ID. |
| Go `projection-builder` | `greenguard_read`: `consumer_inbox`, `device_views`, `reading_history`, `device_latest`, `projection_notifications` | Apply inventory/telemetry events transactionally and emit durable projection-change notifications. Own read schema migrations. |
| Express gateway | No domain table writes | Authenticate, normalize tenant/user/device claims, authorize routes, enforce limits, pass correlation, route commands/queries. |
| Apollo BFF | Restricted read role on `greenguard_read`; Redis cache/pub-sub after baseline works | Tenant-scoped query composition; request-scoped DataLoader; subscriptions with reconnect recovery. |
| React dashboard | Browser state and Apollo cache | Display device state, accepted/pending/projected status, measurement time and projection freshness. |

The first database instance is a deployment convenience. Ownership already matches the future service split; no shared Prisma model grants every service unrestricted access. BFF cannot mutate inboxes or domain tables. Migrator, application, projector and CDC replication credentials are separate.

### Inventory binding contract

`POST /v1/devices` routes to `device-service`; one transaction creates an inventory device with `status=active`, its command receipt, audit entry and `device.registered` outbox event. Inventory status and ingestion readiness are separate: the new device cannot ingest until the event has installed its local binding. A consumer in the telemetry service applies the inventory event to `device_bindings` with that status and initializes `device_streams` once; its inbox and binding changes share a transaction. The UI can display “Registered; preparing ingestion.” This first-slice registration does not claim to complete a multi-step provisioning workflow; Stage 07 adds that business lifecycle and its activation event.

The companion inventory event contract must be added before Stage 02 implementation: common envelope, `event_type=device.registered`, `aggregate_type=device`, `aggregate_id=device_id`, `aggregate_version=binding_version`; payload includes `device_id`, `serial_number`, `site_id`, nullable `bin_id`, and lifecycle status. Use `device.binding_changed` and `device.disabled` for later changes. The same inventory version is an identical duplicate; an older version cannot overwrite a newer binding.

This asynchronous binding has a defined consistency limit: revocation/disable changes become effective after the binding consumer applies them. It does not promise an atomic global revocation across two databases. Stage 04 must measure propagation lag and reject new ingest when the binding feed is stale beyond a chosen configured bound; Stage 07 adds provisioning saga/compensation. Short-lived credentials and later revocation policy complement that bound. Cross-tenant permission is checked on every request regardless of feed freshness.

Prove feed freshness with periodic source/connector heartbeat checkpoints consumed and persisted by the binding consumer, including source commit time/position, consumer-observed position and bounded clock-skew assumptions. An old `device_bindings.applied_at` or last device-event timestamp alone is insufficient: a healthy idle stream has no device changes. Admission fails closed when the checkpoint/lag bound is exceeded. Test a healthy idle tenant, stalled connector, stalled binding consumer, delayed disable, and recovery before allowing the device to resume ingest.

## 3. Canonical event contract

The proposed contract is [telemetry-recorded.v1.schema.json](../contracts/events/telemetry-recorded.v1.schema.json); the example is [telemetry-recorded.v1.valid.json](../tests/fixtures/events/telemetry-recorded.v1.valid.json). These are **new proposed artifacts**, not translations already running against archived data. Old producers must use explicit adapters if replayed into the new model.

```json
{
  "event_id": "0d72ff07-a646-4d41-9b5b-52c5f25e4ca8",
  "event_type": "telemetry.recorded",
  "schema_version": 1,
  "occurred_at": "2026-09-21T15:00:00.125000Z",
  "tenant_id": "11111111-1111-4111-8111-111111111111",
  "aggregate_type": "device_telemetry_stream",
  "aggregate_id": "33333333-3333-4333-8333-333333333333",
  "aggregate_version": "42",
  "correlation_id": "4d9d9d30-d209-446e-99ea-d40ab0953d0d",
  "causation_id": "8a2d3d4f-6b73-4fca-9348-4a0a6d3ce7a1",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "payload": {
    "reading_id": "bb70cd06-0720-461a-8ecf-a56754985f87",
    "device_id": "33333333-3333-4333-8333-333333333333",
    "site_id": "22222222-2222-4222-8222-222222222222",
    "bin_id": "55555555-5555-4555-8555-555555555555",
    "binding_version": "3",
    "source_message_id": "sensor-003.boot-018.reading-000042",
    "observed_at": "2026-09-21T14:59:59.500000Z",
    "received_at": "2026-09-21T15:00:00.100000Z",
    "measurements": {
      "temperature_c": 28.75,
      "relative_humidity_percent": 66.2
    }
  }
}
```

### Field rules beyond JSON Schema

1. UUID strings are lowercase and server-generated identity fields reject the all-zero UUID. `payload.device_id` equals `aggregate_id`; authenticated tenant equals `tenant_id`; site/bin/binding come from the server's accepted device binding, not caller input.
2. PostgreSQL signed bigint versions are encoded as **decimal strings** to avoid JavaScript integer precision loss. Parse exactly; enforce `1 <= version <= 9223372036854775807`; do not use `Number()` for version comparison. Inventory and telemetry versions are different counters.
3. `observed_at` is the device observation time; `received_at` is server arrival time; `occurred_at` is server time when accepting the domain event inside the transaction. It is not a claim of PostgreSQL's eventual commit timestamp. Serialize all to UTC with no more than six fractional digits, matching the stored precision.
4. Accept finite temperature and relative humidity values only. The proposed v1 input envelope is temperature `[-80,120]` Celsius and relative humidity `[0,100]` percent; at least one must be present. These are explicit initial device validation limits, **not spoilage thresholds or a validated agricultural scoring model**. Do not replace a missing metric with zero.
5. Reject an observation more than five minutes ahead of `received_at` with a clear clock-error response in the first local profile; make the allowed future skew an explicit later device policy. Historical observations remain eligible; read models select latest by observed time and do not erase history. Replayers validate using original timestamps, not today's clock.
6. `correlation_id` follows the user/device request chain. `causation_id` is the accepted command ID. Keep both stable across delivery retries. Record each delivery attempt's trace span separately; do not overwrite the origin `traceparent`. Reject all-zero trace/span IDs even though the JSON regex alone accepts them.
7. V1 is immutable and strict (`additionalProperties: false`). Adding a field that old validators reject needs a reviewed new contract/version and consumer-first rollout; do not silently loosen this file. Retain v1 fixtures and replay adapters. Topic/subject evolution is an explicit migration, not a magic `schema_version` bump.
8. JSON Schema `format` is not universally an assertion. CI and consumers must enable actual UUID/date-time checks, then apply these semantic cross-field rules. Merely parsing JSON does not validate the contract.

### Kafka topics, key, value and registry

| Topic | Content / partitioning | First-slice consumer |
|---|---|---|
| `greenguard.raw.inventory.outbox` | Debezium envelope for inventory outbox inserts; one partition initially | Canonical transformer inventory adapter |
| `greenguard.raw.telemetry.outbox` | Debezium envelope for telemetry outbox inserts; one partition initially | Canonical transformer telemetry adapter |
| `greenguard.inventory.device.v1` | Canonical device events; key `tenant_id:aggregate_id` | Telemetry binding consumer and read projection |
| `greenguard.inventory.facility.v1` | Canonical `site.changed` / `bin.changed`; key `tenant_id:aggregate_id`; six partitions | Read projection |
| `greenguard.telemetry.recorded.v1` | Canonical telemetry v1; key `tenant_id:aggregate_id` | Read projection; later Cassandra/risk/search consumers |
| `greenguard.quarantine.v1` | Original bytes/source coordinates/error/attempt/schema metadata, tenant only when valid | Operator tooling; replay is explicit |

Provision topics explicitly. The small local profile can use one broker/RF1 and must be labeled non-HA; the reliability profile uses multiple brokers, RF3/minISR2 and tests leader failures. Producers request all in-sync replica acknowledgements and hash the complete aggregate key. `acks=all` on RF1 does not provide replica-failure tolerance.

JSON Schema files in `contracts/events/` are the source of truth. Canonical Kafka values are UTF-8 plain JSON conforming to those schemas, with no Registry wire-format prefix. Per [ADR-0010](adr/0010-schema-registry-contract.md), the six required UTF-8 headers are `event_id`, `event_type`, `schema_version`, `tenant_id`, `correlation_id` and `traceparent`; consumers check their agreement with the validated envelope. Keys are `tenant_id:aggregate_id` (the device ID for device and telemetry events). No `schema_subject`, `schema_id` or `content-type` header is required. An optional `schema_checksum` is diagnostic; when checksum enforcement is enabled, an unknown or mismatched checksum is quarantined.

Registry is a CI/release compatibility and registration gate, not a runtime hot-path or startup network dependency. Register the exact reviewed JSON Schema under `<topic>-value` with `BACKWARD` compatibility, using an explicit union for topics carrying multiple event types. Retain a release manifest mapping topic, subject, Registry version/ID, repository commit and schema file SHA-256. Compatibility checks exercise old/new fixtures with pinned validators. Transformer readiness requires compilation of packaged local schemas with format assertions and semantic validation; unknown event types/versions are quarantined using those schemas. Approved runtime processing and historical replay survive Registry outages; an outage blocks a new release's registration gate. A future framed codec requires a coordinated migration ADR.

One raw partition preserves the source order for this learning slice. Scaling raw CDC partitions is Stage 13 work: repartition by aggregate before concurrent processing or tolerate arbitrary order with version/gap handling. Debezium's default outbox primary-key routing by event ID is not an aggregate-order guarantee. Never infer aggregate order from a non-key-aware Kafka balancer.

## 4. Proposed SQL shape and ownership rules

These snippets are **design specifications, not installed migrations**. Implementation must generate a complete ordered migration set and test from an empty database. UUID generation happens in the owning application so tests can inject deterministic identities; no extension is assumed implicitly.

### Inventory database

- `tenants(tenant_id PK, name, created_at)`.
- `sites(tenant_id, site_id, name, PRIMARY KEY(tenant_id,site_id))`.
- `bins(tenant_id, bin_id, site_id, name, PRIMARY KEY(tenant_id,bin_id), FK(tenant_id,site_id))`.
- `devices(tenant_id, device_id, site_id, bin_id nullable, serial_number, status, binding_version bigint, created_at, updated_at, PRIMARY KEY(tenant_id,device_id), UNIQUE(tenant_id,serial_number))`.
- Composite tenant-aware foreign keys prohibit a tenant A device from referring to tenant B's site/bin. Add a constraint/transaction check that bin belongs to the selected site.
- Device creation changes `devices`, `command_receipts`, `audit_events` and `outbox_events` in one Prisma transaction. No HTTP/gRPC/broker/provider call occurs inside this SQL transaction.

### Telemetry database

```sql
CREATE TABLE device_bindings (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  site_id uuid NOT NULL,
  bin_id uuid,
  inventory_version bigint NOT NULL CHECK (inventory_version > 0),
  status text NOT NULL CHECK (status IN ('active','disabled','deleted')),
  applied_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id)
);

CREATE TABLE device_streams (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  last_version bigint NOT NULL DEFAULT 0 CHECK (last_version >= 0),
  PRIMARY KEY (tenant_id, device_id),
  FOREIGN KEY (tenant_id, device_id)
    REFERENCES device_bindings (tenant_id, device_id)
);

CREATE TABLE readings (
  tenant_id uuid NOT NULL,
  reading_id uuid NOT NULL,
  device_id uuid NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  source_message_id text NOT NULL,
  site_id uuid NOT NULL,
  bin_id uuid,
  binding_version bigint NOT NULL CHECK (binding_version > 0),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  temperature_c double precision,
  relative_humidity_percent double precision,
  PRIMARY KEY (tenant_id, reading_id),
  UNIQUE (tenant_id, device_id, source_message_id),
  UNIQUE (tenant_id, device_id, stream_version),
  FOREIGN KEY (tenant_id, device_id)
    REFERENCES device_bindings (tenant_id, device_id),
  CHECK (temperature_c IS NOT NULL OR relative_humidity_percent IS NOT NULL),
  CHECK (temperature_c IS NULL OR temperature_c BETWEEN -80 AND 120),
  CHECK (relative_humidity_percent IS NULL OR relative_humidity_percent BETWEEN 0 AND 100)
);

CREATE TABLE ingest_receipts (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  source_message_id text NOT NULL,
  command_id uuid NOT NULL,
  reading_id uuid NOT NULL,
  event_id uuid NOT NULL,
  normalized_request jsonb NOT NULL,
  response_body jsonb NOT NULL,
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, source_message_id),
  FOREIGN KEY (tenant_id, reading_id) REFERENCES readings (tenant_id, reading_id)
);
```

The device-stream row lock serializes version assignment for one device. That is intentional for the first slice; it avoids per-device sequence gaps caused by independent PostgreSQL sequences. Different devices can ingest concurrently. Later throughput work must preserve this invariant rather than remove it without a replacement.

`normalized_request` contains the validated caller-observation fields only: source message ID, device ID, normalized observed timestamp, and measurements. It excludes arrival time, trace ID and server-derived binding fields, so a legitimate transport retry compares equal even after those transient values change. Require `observed_at` from the device; do not invent a new timestamp on every retry. Compare structured JSONB semantics, not raw request-byte hashes with arbitrary key ordering.

### Immutable outbox, in each owning database

```sql
CREATE TABLE outbox_events (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  event_type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  occurred_at timestamptz NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid NOT NULL,
  traceparent text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, aggregate_type, aggregate_id, aggregate_version)
);
```

One observation emits one event at its stream version in this slice. If an aggregate later emits several event types per state transition, introduce an explicit event ordinal or a separate event sequence; do not casually remove the uniqueness invariant.

Applications get INSERT rights on outbox; normal runtime does not UPDATE its envelope/payload. CDC captures inserts and snapshot records. Do not add `published_at` mutations to the canonical source row just to trigger another CDC event. A fallback relay, if later enabled, keeps leases/delivery attempts in a **separate** table and uses the existing outbox event ID and payload.

`audit_events` is also append-only and commits with the domain command. It records tenant, actor type/ID, action, command/event/resource IDs, outcome and timestamp, with no raw credentials. Define the table in the same migration bundle; it is not an optional best-effort log callback.

### Read database

- `consumer_inbox(consumer_name, tenant_id, event_id, event jsonb, processed_at, PRIMARY KEY(consumer_name,tenant_id,event_id))`. Store the normalized event initially so duplicate-content comparison is unambiguous; introduce a verified canonical digest only when needed. Receipt retention must cover the supported replay/dedup horizon.
- `device_views(tenant_id, device_id, site_id, bin_id, serial_number, status, inventory_version, updated_at, PRIMARY KEY(tenant_id,device_id))` from inventory events.
- `reading_history(tenant_id, reading_id, device_id, event_id, stream_version, source_message_id, site_id, bin_id, observed_at, received_at, temperature_c nullable, relative_humidity_percent nullable, projected_at, PRIMARY KEY(tenant_id,reading_id), UNIQUE(tenant_id,event_id), UNIQUE(tenant_id,device_id,stream_version))`.
- `device_latest(tenant_id, device_id, reading_id, event_id, selected_observed_at, selected_stream_version, max_seen_stream_version, projected_at, PRIMARY KEY(tenant_id,device_id))`.
- `projection_notifications(notification_id PK, tenant_id, device_id, event_id, created_at, delivered_at nullable)` inserted in the projection transaction. This small local notification outbox feeds the pub-sub delivery adapter; it is not the source domain event ledger.

History retains every accepted reading, including late ones. Latest selection is the maximum lexicographic pair **`(observed_at, stream_version)`**. `max_seen_stream_version` is a separate ingestion watermark; do not mistake it for proof that every earlier version arrived. Track contiguous version/gaps if the UI or recovery requires a complete watermark. A duplicate event makes no second history or notification record.

If inventory projection arrives after telemetry, store the telemetry row with event-carried site/bin metadata and mark inventory enrichment pending. Do not drop/commit telemetry because another topic's device view is not ready. A later inventory event must not erase a reading's historical binding metadata.

### RLS and connection pooling

Every tenant table uses enabled/forced RLS, a policy equivalent to `tenant_id = current_setting('app.tenant_id', true)::uuid`, and tenant-aware keys. Runtime roles are not table owners, superusers or BYPASSRLS roles. Set tenant context using a parameterized `set_config` inside each transaction with the local flag true. Missing tenant yields no permitted tenant rows; malformed tenant is rejected before SQL.

Use transaction-scoped context with PgBouncer transaction pooling. Never set session tenant once and return that connection to a pool. Producer/consumer jobs use tenant from a validated, authorized source contract and set it inside the transaction per event/batch. BFF query helpers must actually use the scoped transaction helper; defining it without routing reads through it is not protection. Migration/replication privileges are separately scoped and never reused by the application.

## 5. Exact command → commit → publish → acknowledge sequence

```mermaid
sequenceDiagram
  participant D as Device / simulator
  participant G as Gateway / ingest transport
  participant T as Go telemetry-ingest
  participant W as Telemetry Postgres
  participant C as Debezium Connect
  participant R as Raw Kafka outbox topic
  participant X as Canonical transformer
  participant K as Canonical Kafka topic
  participant P as Projection builder
  participant Q as Read Postgres
  participant B as GraphQL BFF
  participant U as React dashboard
  D->>G: Observation + stable source_message_id + credential
  G->>T: Authenticated principal + validated transport + trace
  T->>W: BEGIN; set local tenant; lock device stream
  T->>W: Read existing receipt or write reading + outbox + audit + receipt
  T->>W: COMMIT
  T-->>D: 202 stored, same reading/event IDs on retry
  W-->>C: Committed outbox insertion in WAL
  C->>R: Persist raw CDC record
  X->>R: Fetch without advancing committed offset
  X->>X: Validate outbox mapping and canonical schema
  X->>K: Publish same event ID and aggregate key; wait for ack
  X->>R: Commit raw offset after ack
  P->>K: Fetch without advancing committed offset
  P->>Q: BEGIN; set local tenant; insert inbox
  P->>Q: Insert history; select latest; insert notification outbox
  P->>Q: COMMIT
  P->>K: Commit source offset
  U->>B: Tenant-authenticated query or reconnect refresh
  B->>Q: Scoped read transaction
  Q-->>U: Reading + observed/projected times + event ID
```

### A. Ingest transaction

1. Authenticate the device/user, check permitted ingest scope and bind the claimed tenant/device. The ingest service verifies the credential or a signed internal principal over the authenticated service channel; it never trusts an unsigned forwarded `x-tenant-id`. Validate body size, timestamp, finite measurements, allowed fields and source ID before opening a transaction. Both HTTP and gRPC call the **same application service**.
2. Start a PostgreSQL transaction and set local tenant from the principal. Lock the existing `(tenant,device)` stream row `FOR UPDATE`. All code paths use a consistent lock order.
3. Look up the existing ingest receipt under this lock. If normalized input matches, return its stored response after ending the transaction; do not advance the sequence, create a reading, refresh its timestamp or publish another event. If input differs, return 409 `idempotency_conflict` and retain the original record. Authentication still applies to duplicates.
4. For a new observation, lock/read the local binding `FOR SHARE`; require `active` and acceptable binding-feed freshness. If not yet present, return 409 `device_not_ready`; disabled/unauthorized returns the agreed 403/404 policy. Binding consumer uses the same consistent stream-before-binding lock order when both are needed. Inventory initialization creates both in one transaction before either is available.
5. Increment `device_streams.last_version` safely. Generate command, reading and event UUIDs. Preserve request correlation/origin trace. Build the canonical payload from the accepted input plus persisted binding.
6. Insert reading, outbox event, audit event and complete receipt/response in the same transaction. Fail/rollback if any write fails. No Kafka or provider request occurs in this transaction.
7. Commit. Only then return 202 with stored IDs. If connection loss makes commit outcome unknown, return a retriable/indeterminate error; client resubmits the same source ID and the receipt resolves the outcome. Do not attempt a compensating delete of a possibly committed reading.

Proposed stored response:

```json
{
  "status": "stored",
  "reading_id": "bb70cd06-0720-461a-8ecf-a56754985f87",
  "event_id": "0d72ff07-a646-4d41-9b5b-52c5f25e4ca8",
  "stream_version": "42",
  "projection_status": "pending"
}
```

`projection_status=pending` describes the original asynchronous acknowledgement. A repeated request returns that same acceptance receipt, even if the view has since caught up; query current projection status separately.

### B. Debezium and canonical transform

1. Enable logical replication and publish **only the owning outbox table** into the connector's raw outbox topic. Do not simultaneously derive another `telemetry.recorded` event from `readings` table CDC.
2. Preserve a committed row's event identity and metadata during snapshots (`op=r`) and inserts (`op=c`). Snapshot duplicates are valid deliveries. Unknown updates are contract/config errors. Deletes/tombstones from approved retention are handled explicitly and cannot be mistaken for telemetry.
3. Transformer validates source table, event type/version, required metadata, payload and registry contract; deterministically constructs the canonical JSON from stored columns. It must not replace timestamps/IDs on retry or repair malformed data by guessing a tenant.
4. Publish canonical event with hash-partitioned aggregate key and synchronous broker acknowledgement. Only then commit the raw-topic offset. A crash between the two causes duplicates; the downstream inbox handles them.
5. On invalid input, publish original bytes and source topic/partition/offset/error/schema details to quarantine; wait for acknowledgement **before** committing the bad source offset. If quarantine is unavailable, pause/retry the partition, expose degraded readiness/metrics, and do not skip it.
6. Start with sequential processing inside each raw partition. If batching is added, commit only the highest **contiguous** successfully published/quarantined offset. Never commit the maximum completed offset while lower offsets are pending. Separate fetching from a timer-driven flush so a partial batch does not wait for another incoming record indefinitely.

### C. Projection transaction

1. Fetch canonical Kafka message without auto-committing. Verify allowed schema, key/envelope tenant and aggregate match, semantic payload rules and event identity. Determine tenant before SQL.
2. BEGIN; set local tenant. Insert inbox receipt with `ON CONFLICT DO NOTHING RETURNING`. On duplicate, compare its stored JSONB event semantics: identical means no-op; changed content means rollback and quarantine/incident. Two concurrent handlers for one event must converge safely through the unique constraint.
3. Insert history and update latest only if `(observed_at,stream_version)` is newer. Always preserve nullable measurements; never turn absence into zero. Update max-seen version separately and record version gaps if tracking completeness.
4. Insert one `projection_notifications` entry keyed by source event ID/consumer purpose. COMMIT. Only now commit the Kafka offset.
5. On transient DB error or deadlock/serialization conflict, rollback and retry within a bounded policy. When retry budget is exhausted, confirmed quarantine is the only alternative to preserving the uncommitted offset. Never ignore DLQ errors.
6. Use one handler at a time per partition initially. Cross-partition concurrency is safe because aggregate keys keep a device on one canonical partition; replays still need deterministic version/event-time rules. Scaling a shared worker pool requires explicit completion-frontier coordination before accepting offset commits.

### D. Query and live delivery

1. BFF validates HTTP and WebSocket tokens through the same claim-normalization routine, and loads current permitted tenant context. Tenant selection is checked against membership; an arbitrary GraphQL `tenantId` argument cannot override it.
2. `device(deviceId)` returns the tenant-scoped inventory view plus `latestReading` and freshness metadata. `reading(readingId)` returns the accepted reading once projected. Querying a foreign tenant's ID returns the same no-result/authorization behavior as the chosen public policy; cache hits cannot bypass authorization.
3. Apollo DataLoader is created per request and scoped by tenant. Add Redis cache only after uncached tests pass; key by tenant, authorization scope where relevant, resource and projection version. Server cache failure must not erase correctness.
4. For the first working screen, poll the accepted reading ID with a bounded backoff and display “Stored; updating dashboard” until visible. Show `observed_at` separately from `projected_at`; a historical reading may be projected successfully without replacing the latest reading.
5. Stage 08's live enhancement relays committed projection notifications into Redis pub-sub and BFF subscriptions. Redis is ephemeral: publication or reconnect can miss a notification. Subscription notifications are invalidations, and reconnect performs a fresh scoped query/history catch-up. Do not advertise a subscription push as a durable event log.
6. The gateway uses a standards-compliant WebSocket proxy, preserving upgrade/subprotocol/handshake and buffered bytes. Browser E2E connects through the gateway, not directly to BFF only. JWT claim names/roles and token-expiry handling are identical across HTTP/WS.

Proposed BFF view contract:

```graphql
type Query {
  device(deviceId: ID!): DeviceView
  reading(readingId: ID!): ReadingView
}
type DeviceView {
  deviceId: ID!
  serialNumber: String!
  status: String!
  latestReading: ReadingView
  freshness: ProjectionFreshness!
}
type ReadingView {
  readingId: ID!
  eventId: ID!
  streamVersion: String!
  observedAt: String!
  projectedAt: String!
  temperatureC: Float
  relativeHumidityPercent: Float
}
type ProjectionFreshness {
  lastProjectedAt: String
  maxSeenStreamVersion: String
  hasKnownGap: Boolean!
}
```

These are proposed fields, not an implemented GraphQL schema. Use a validated DateTime scalar when implementing; version strings remain exact. `hasKnownGap=false` means the tracker has not observed a gap, not proof of permanent end-to-end completeness.

## 6. Crash and fault matrix

| Crash/fault injection | Durable state at that instant | Required retry/recovery result |
|---|---|---|
| Before input validation or before BEGIN | None | Retry same source ID; invalid input creates no domain/outbox row. |
| After reading insert, before outbox insert | Uncommitted transaction only | Connection rollback removes reading; retry creates exactly one committed reading/event. |
| After outbox insert, before audit/receipt | Uncommitted transaction only | Rollback removes all partial writes; no CDC event from uncommitted rows. |
| After DB COMMIT, before HTTP response | Reading/outbox/audit/receipt committed | Retry returns same receipt, IDs and sequence; no duplicate accepted reading. |
| Lost connection during COMMIT | Outcome initially unknown | Same idempotency identity resolves committed versus rolled-back result; no guessed failure cleanup. |
| Connector stopped or Kafka unavailable | Reading/outbox committed; WAL retained according to configured capacity | HTTP can remain available while backlog capacity is safe; CDC catches up. Alert on WAL/backlog; apply admission control before storage exhaustion. |
| Connector snapshot repeats an outbox row | Same event ID emitted again | Transformer preserves ID; projection inbox no-ops duplicate. |
| Canonical publish fails | Raw offset uncommitted | Retry same payload/key/ID; no source commit on error. |
| Canonical publish succeeds, transformer crashes before raw commit | Canonical event exists; raw offset pending | Event may publish again; consumer effect once. |
| Malformed raw event and quarantine healthy | Quarantine record confirmed | Advance only its contiguous safe source frontier; valid later events proceed. |
| Malformed raw event and quarantine unavailable | Neither safe canonical event nor quarantine | Do not commit; pause/backpressure; visible alert and recovery. |
| Projection crashes after inbox insert before view update | Inbox insertion uncommitted | Roll back receipt and partial effects; redelivery applies full projection. |
| Projection crashes after SQL COMMIT before Kafka offset | Inbox/history/latest/notification committed | Redelivery sees identical inbox, makes no second effect, commits offset. |
| Later batch finishes while an earlier offset is pending | Some out-of-order work completed | Do not advance committed frontier over gap; restart cannot lose earlier effect. |
| Same event ID arrives with different payload | Original inbox/effect exists | Reject and quarantine new payload, signal corruption; never silently treat as duplicate. |
| Old observed reading arrives after newer reading | Both valid observations | History contains both; latest stays selected by observed-time/version rule. |
| Two distinct readings share the same observed timestamp | Both accepted with different stream versions/reading IDs | Both retained; deterministic tie-break by stream version; no timestamp-key overwrite. |
| Inventory arrives after telemetry read projection | Telemetry event valid, inventory view missing | Store history; mark enrichment pending; do not discard reading. |
| BFF/Redis unavailable after successful projection | Read state durable | Browser queries when available; caches/pub-sub are reconstructible. |
| Push notification lost or WebSocket disconnects | Read state and notification outbox durable | Reconnect refresh discovers committed data; UI does not remain permanently stale. |
| Replay an entire retained range | Same IDs into chosen projection version | Same result; no duplicate history/effect; visible replay progress and gaps. |
| Retention would delete data before recovery checkpoint | Potential loss of recovery evidence | Retention job refuses/alerts; no claim of unlimited replay outside verified retention. |

Delivery is not safe merely because each happy-path component returns 200. The test harness must stop a process at each named boundary and inspect database state, topic offsets and resulting view, then restart it.

## 7. Tests and expected assertions

Assign stable IDs so implementation PRs and archived logs can point to a specific promise. These are **test specifications**, not tests already run.

| IDs / layer | Scenario and assertions |
|---|---|
| C01–C04 / contract | Fixture passes schema + semantic validation; invalid UUID/date, unknown fields, missing metrics, NaN/infinity, out-of-range humidity, mismatched device/aggregate, all-zero trace ID fail. Values above JS safe-integer range round-trip as exact version strings; bigint overflow fails. |
| C05 / registry | Deployed schema ID/subject/file hash agrees; unknown contract blocks publication/consumption; additive/breaking changes are classified by actual consumer fixture tests. |
| D01 / migrations | Create all three DBs from empty; every table/constraint/RLS/index exists; apply again safely; upgrade previous migration fixture; no handwritten test-only table setup that hides missing migrations. |
| D02 / tenant RLS | Runtime roles cannot bypass RLS; no tenant returns no rows; tenant A cannot select/insert/update B using SQL constraints; composite FK rejects cross-tenant site/device references. |
| D03 / pool leakage | Alternate A/B requests over a reused PgBouncer connection; rollback/error/cancel paths clear local tenant; no session state leaks. |
| I01 / successful ingest | One authenticated request creates exactly one reading, outbox, receipt and audit; event fields match committed row/binding; returned IDs match. |
| I02 / retry | 20 concurrent identical requests produce one reading/event/sequence increment and identical response IDs; retries with changed measurements return 409. |
| I03 / ordering | Concurrent distinct readings for one device get unique increasing versions; other devices progress independently; binding initialization cannot expose half-created stream state. |
| I04 / domain failures | Invalid/missing/disabled/foreign device rejected; forged tenant/site ignored/rejected; future-skew error creates no row; missing measurement remains null. |
| I05 / transactional failure | Inject each write failure and pre-commit crash; all-or-none rows. Inject ambiguous commit/response loss; replay request resolves without duplicates. |
| E01 / CDC ownership | Exactly one canonical event identity derives from each committed outbox row; raw `readings` CDC cannot manufacture a second domain event. Rollback row never publishes. |
| E02 / relay outage | Stop connector/Kafka; ingest valid observations within configured backlog budget; restart and account for every committed event; backlog/WAL metric increases then drains. |
| E03 / snapshot + transformer crash | Repeat snapshot records and crash after canonical broker ack; duplicates may be transported but projector effect remains once. |
| E04 / poison + DLQ failure | Malformed event is preserved with original bytes/coordinates; DLQ failure prevents offset advance; after repair the partition resumes without skipped valid offsets. |
| E05 / partial-batch timer | Publish fewer records than batch size and no further traffic; maximum configured flush latency still met; stop/restart preserves pending records. |
| P01 / inbox atomicity | Crash before/after inbox/view/commit boundaries; no durable receipt without its effect; duplicate effect count exactly one. |
| P02 / semantic duplicate/collision | Same event bytes with JSON property-order/whitespace differences compare equal semantically; same ID with changed content quarantines and does not overwrite. |
| P03 / reorder + missing | Deliver versions 42,40,41 with varying observed times; history complete, latest deterministic, version-gap state correct. Never use max-seen alone as complete-through watermark. |
| P04 / same timestamp | Two source messages with identical observed timestamp retain two history rows; tie-break deterministic. |
| P05 / offset frontier | Delay/fail low offset while higher offset finishes; committed offset cannot pass missing work. Assert using real broker group offsets after process restart. |
| P06 / replay | Rebuild a new empty projection version from retained canonical range; compare sorted semantic rows/counts and latest selections to reference; switch views only after validation. |
| Q01 / BFF auth | Same issuer/audience/tenant/roles accepted over HTTP and WS; expired/invalid token denied; foreign device/read IDs inaccessible; DataLoader/cache cannot cross tenants. |
| Q02 / freshness | Immediately after 202, screen can show pending; later reading ID is visible; older observed data shows as processed without falsely replacing latest. |
| Q03 / real browser | Through gateway, register device → wait for active binding → submit simulator observation → view reading; verify measurement and projected/observed times; WS handshake/reconnect succeeds. |
| Q04 / cache/pub-sub outage | Stop Redis and disconnect client; scoped query remains correct; reconnect refresh catches up; duplicates do not duplicate chart points. |
| O01 / correlation | Trace/log chain retains request correlation/event ID across HTTP/gRPC/outbox/CDC/Kafka/projection/BFF; telemetry payload excludes keys/tokens. |
| O02 / real metrics | Sample emitted metrics match dashboard/query labels; inject consumer lag/failure and see the expected alert; no-data is distinct from success. |
| G01 / mandatory CI | Break one schema/migration/tenant/event test and ensure gate fails; cancelled/skipped required job cannot produce passing release gate; scanner failure is not synthesized as an empty success report. |

Start tests with a two-tenant fixture, two sites, one bin per tenant and at least two devices per tenant. Use a fake signed issuer for offline local tests; run real Auth0 sandbox tests later without replacing the isolation suite. Use actual PostgreSQL/Kafka/Connect instances for transaction/offset tests; mocked broker calls cannot prove commit ordering. Testcontainers/containerized integration is appropriate; keep deterministic unit tests for event mapping/domain validation.

## 8. Stage-by-stage delivery cuts, 01–08

| Master stage | Work that belongs to this slice | Evidence required before expanding |
|---|---|---|
| 01: foundation | Pin Go/Node/Python/runtime/toolchain, new workspace conventions, Docker/Linux paths, local env/certs, honest CI; initial Postgres profile | Clean-clone bootstrap transcript, locked dependencies, all starting apps' health/unit checks, intentionally failing required check blocks CI. No Kafka installation required for the very first commit. |
| 02: domain/contracts | Tenant/site/bin/device model, ownership/Prisma and pgx adapters, numbered migrations, RLS/PgBouncer, HTTP/gRPC and proposed event schemas | D01–D03, C01–C04; device registration transaction plus binding/inventory event contract reviewed. |
| 03: durable write | Shared HTTP/gRPC ingest use case, stable observation idempotency, reading + outbox + audit + receipt transaction | I01–I05 with real DB. Query DB evidence of immutable committed outbox before adding brokers. |
| 04: event transport | Kafka KRaft/Registry/Connect/Debezium, scoped outbox capture, canonical transformer, topics/ACLs, binding consumer, quarantine/recovery controls | E01–E05 and C05; no lost committed events through outages. Production fallback polling remains disabled until its overlap/fencing tests exist. |
| 05: projection | Separate read DB, inbox+history+latest, gap/freshness tracking, projection notification outbox and replay | P01–P06. Add Cassandra/search as independent consumers after this reference projection is reliable; neither replaces the event identity rules. |
| 06: risk/alerts | Extend same event to risk → alert → notification ownership contracts; retain simple reading screen as baseline | The minimal slice can already verify readings; master Stage 06 still requires its full score/alert/delivery/acknowledgement acceptance before being marked done. |
| 07: saga/coordination | Make device provisioning lifecycle durable, including timeout/compensation; add serializable quotas, mTLS and lease/fencing exercises | Successful telemetry slice is necessary but insufficient: master saga crash/timeout/stale-leader matrix must also pass. |
| 08: gateway/BFF/screen | Complete React/Apollo view, request-scoped DataLoader/cache, proper WS gateway proxy, live invalidation+catch-up, Storybook/error states | Q01–Q04, O01–O02, G01; browser proof using real backends; master risk/ack UI additionally required. |

Instrumentation starts with the write path; Stage 11 later completes operations across the whole platform. Do not call Stages 06/07 complete just because a temperature value reached the screen. Do not create a second competing ingest implementation when adding another transport or provider technology.

## 9. What existing source teaches this slice to avoid

All GrainGuard paths here refer to preserved commit `c00a3810897921a4bf4d1065014776ff45dbc044`; fuller evidence is in [its source audit](../../GRAINGUARD_INVENTORY_AND_PLAN.md). CarePulse integration findings are recorded separately in [its audit](../../CAREPULSE_INVENTORY_AND_PLAN.md).

| Existing behavior | Why the new slice changes it |
|---|---|
| GrainGuard `telemetry-service/internal/application/record_telemetry.go:72–127` already stores domain row+outbox atomically | Keep this fundamental pattern, add persistent request receipt/audit and a single shared ingest use case. |
| `apps/ingest-service/main.go:418–454` sends direct Kafka events | Fast ingest bypasses write DB/outbox. New HTTP/gRPC transports both use the same durable DB transaction. |
| Compose Debezium watches `telemetry_readings`, while polling relay also publishes telemetry | Independent paths produce distinct representations/identities. New CDC captures immutable outbox only for canonical domain events. |
| Telemetry migration contains two 000009 versions; read migration assumes missing `device_projections`; `add_api_keys.sql` is unnumbered | Clean-schema tests are mandatory; never prepare missing tables only in a test setup or depend on old volumes. |
| `cdc-transformer/cmd/main.go:157` blocks on fetch inside ticker loop; malformed record offset can be committed before buffered valid records | Timer-driven flush and contiguous commit frontier must be explicit tests. Unused internal consumer classes do not prove the active entrypoint works. |
| `read-model-builder/.../telemetry_projection.go:218–277` skips malformed records; consumer ignores DLQ write errors then commits | Every input ends in committed effect or confirmed durable quarantine; failures retain source offset. |
| Search handlers catch errors then loop commits; risk consumer auto-commits | Future consumers inherit the same publisher/consumer acknowledgement contract rather than inventing weaker behavior. |
| Mixed camelCase/snake_case JSON and duplicate protobuf/generated locations | One proposed schema with explicit old-version adapters, subject registration and semantic fixtures. |
| Gateway latest-reading SQL/cache only includes device ID (`services/device-query.ts:20,170`) | Tenant scope is in keys/queries/policies and tested through cache hits as well as misses. |
| RLS helper exists but ordinary BFF code uses unrestricted pool queries | All BFF reads pass through a scoped transaction; runtime role cannot bypass RLS. |
| Gateway WS hand-constructs incomplete 101 response; BFF HTTP/WS tenant claim namespaces differ | Use tested proxy/claim normalization; browser test goes through real edge path. |
| Cassandra primary key collapses equal timestamps | SQL reference history uses reading/event identity; later Cassandra adds bucket and event ID to preserve distinct readings. |
| README SLO/canary queries do not match emitted metrics; CI gate omits prerequisites | Evidence includes real emitted series and deliberate failures; no readiness claim from files or green-looking artifacts alone. |
| CarePulse has disconnected telemetry/risk topics, incompatible envelopes and a projection consumer that is not started | A transport contract test and real user-path test prove the active process wiring; module/folder existence is not enough. |

## 10. Retention, replay, local evidence and open implementation decisions

The source event history is only replayable for the retention window actually configured and verified. Outbox cleanup must respect connector recovery checkpoints and chosen recovery margin. WAL disk growth must be monitored when connectors stop. Kafka retention is not an infinite backup; if longer history is required, add an immutable archival sink and prove restore/replay before deleting the only recoverable source. Inbox retention, event retention and idempotency receipt retention must be designed together.

A fallback polling relay is an explicit recovery mode, not another producer generating its own IDs. It reads immutable outbox records, publishes identical canonical events, records its own lease/attempt bookkeeping separately, and tolerates overlapping CDC redelivery through the same inbox. First implement CDC correctly; enable fallback only with an operator procedure, bounded selection/checkpoint and tests proving overlap cannot create extra domain effects. Ownership fencing protects a fallback relay's own work claims; it does not magically make broker and DB commits atomic.

Save the following after implementation: commit SHA, dependency lockfiles, image digests, migrations and schema registry mapping, exact run commands/environment profile (secrets redacted), test results, fault-injection transcript, before/after DB counts, relevant Kafka offsets/lag, representative trace/log IDs and browser proof. Record assertions and tolerances with each artifact. Generated test results must be labeled as new evidence and never substituted for expired historical Actions logs.

Decisions to resolve during coding are bounded: supported pinned library/runtime versions; the concrete Schema Registry validator/codec implementation; future-skew and stale-binding admission thresholds; request/deadline/body limits; local retention and disk budgets; migration deployment strategy; CDC/outbox topic partition growth; deterministic event canonicalization if hashing is introduced. Each decision has an owner/ADR and a test. None should require changing the central invariants to make the demo pass.

The supplied schema and fixture have been authored as reviewable contracts. No JSON Schema engine, application process, dependency installer, migration, broker or test suite was executed for this design document.
