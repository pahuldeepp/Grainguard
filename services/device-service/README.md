# services/device-service

Stage 07 inventory provisioning uses this service's database and tenant RLS.
`POST /v1/devices/provisioning` (admin, idempotency key required) creates a
pending device linked to a physical `assetId`, site, and optional bin. Pending
creation emits no `device.registered` event. The separate
`npm run saga:worker -w @greenguard/device-service` process consumes
`greenguard.saga.commands.v1`: `inventory.activate` verifies the pending
device/asset pair and emits the existing valid `device.registered@1` active
event; `inventory.deactivate` compensates only the saga that activated it and
emits `device.status_changed@1` disabled. Command receipts, inventory changes,
CDC events, and result outbox rows commit in one tenant transaction. The worker
publishes results with stable IDs to `greenguard.saga.results.v1` before marking
them published.

The worker needs `INVENTORY_DATABASE_URL` and `KAFKA_BROKERS`; the consumer
group defaults to `greenguard-inventory-saga-v1` (`INVENTORY_SAGA_GROUP`). It
applies every tenant's command inside that tenant's RLS transaction. Results are
discovered through the ID-only SECURITY DEFINER selector
`inventory_saga_result_tenants(after, limit)`, which returns tenant IDs only.
Each pass visits at most 100 tenants after a round-robin cursor and publishes at
most 10 results per tenant. The retired `INVENTORY_SAGA_TENANT_IDS` is rejected
at startup. `make inventory-saga-test` and
`make inventory-saga-kafka-test` exercise live database and Kafka boundaries.

Status: **Stages 02a and 02b implemented; Stage 06a-0 grain-lot placement added locally**: inventory data layer plus the authenticated, versioned HTTP API ([API reference](../../docs/API.md)).

Technology: NestJS, Prisma 7 (`@prisma/adapter-pg`), PostgreSQL, PgBouncer.

Responsibility: authoritative owner of tenants, sites, bins, grain lots, bin occupancy intervals and devices (`greenguard_inventory`), with command receipts, an immutable outbox and an append-only audit log.

## Data access

| Connection                                                | Role                                                | Used by                      |
| --------------------------------------------------------- | --------------------------------------------------- | ---------------------------- |
| `INVENTORY_DATABASE_URL` (PgBouncer, transaction pooling) | `inventory_app`: not owner, no BYPASSRLS, no DELETE | runtime and tests            |
| `INVENTORY_MIGRATION_URL` (direct)                        | `inventory_migrator`: owns the tables               | `prisma migrate deploy` only |

- Every tenant query goes through `withTenant` (`src/db/tenant.ts`), which sets `app.tenant_id` with `set_config(..., true)` inside the transaction. RLS is forced on all nine tables; queries also filter on `tenant_id`.
- Composite keys keep references inside one tenant, and a device's bin inside the device's site.
- Creating a site or bin requires `Idempotency-Key` and writes its version-1 `site.changed` / `bin.changed` event, audit and command receipt atomically. Receipt retries use a transaction-scoped advisory lock; future edits use optimistic `version` comparison/increment. Facility events carry correlation, causation and trace context and route to `greenguard.inventory.facility.v1`.
- Registering a device writes the device, its `device.registered` outbox event, an audit record and an idempotency receipt in one transaction.
- Placing a grain lot locks its bin row, closes the previous half-open occupancy interval, inserts a new version, and writes `lot.changed`, audit and receipt in one transaction. A GiST exclusion constraint forbids overlapping intervals. `lot.changed` is keyed by tenant and bin on a dedicated topic, preserving bin-version order. Each version needs the lot/occupancy context; a future risk consumer selects the interval covering the reading's `observed_at`. The current command supports one lot per bin at a time; empty-bin retirement and historical corrections are still pending.
- Concurrency rules: [ADR-0002](../../docs/adr/0002-concurrency-control.md).

## HTTP API

`/v1` sites, bins, grain lots and devices with RS256 bearer tokens (`@greenguard/tenant-auth`), `Idempotency-Key`, `ETag`/`If-Match`, header-based `API-Version` with `Deprecation`/`Sunset`, problem+json errors and correlation IDs. Configure with `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL` (all three or none) and optionally `API_VERSION_POLICY`, `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_TRACES_SAMPLE_RATIO`. Details: [docs/API.md](../../docs/API.md), [ADR-0003](../../docs/adr/0003-api-versioning.md).

## Commands

```bash
make db-migrate                              # start Postgres + PgBouncer, apply migrations
npm test -w services/device-service          # needs the .env variables; `make verify` exports them
npm run coverage -w services/device-service
```

Schema changes: edit `prisma/schema.prisma`, add a new numbered folder under `prisma/migrations/` (generate the base with `prisma migrate diff`, then append RLS, grants and checks by hand). The D01 test fails if migrations and the schema drift apart.

## Stage 10c import admission

`POST /v1/internal/inventory/imports` admits one validated v1 change from the
MySQL normalizer. This route is mounted only when the normal `AUTH_*` settings
and all seven import settings are present:
`IMPORT_SOURCE_ID`, `IMPORT_AUTH_ISSUER`, `IMPORT_AUTH_AUDIENCE`,
`IMPORT_AUTH_JWKS_URL`, `IMPORT_AUTH_TENANT_CLAIM` (the signed token's
tenant claim), `CONTROL_LOOKUP_URL`, and `CONTROL_LOOKUP_TOKEN`. The import
JWT must use RS256 client credentials, contain `inventory:import`, and resolve
through the tenant control plane's internal OAuth client lookup. The control
plane binding supplies the authoritative tenant and service principal. The
`tenant_id` in the normalized change is checked against that binding and
cannot select another tenant. Human API tokens and machine import tokens cannot
cross into each other's route family. Both remote endpoints require HTTPS;
loopback HTTP is available for local tests. No mTLS is used in this slice.
`IMPORT_SOURCE_ID` binds this service instance to one trusted Task1 source
configuration; a request with another source ID is rejected before database
work. The shared control-plane lookup token alone does not enable the route.

The body is the normalizer's `NormalizedChange` serialized with snake-case
field names, with `source_coordinate.offset` sent as a decimal string so
signed-64-bit Kafka offsets stay exact in JavaScript. The service recomputes
the normalizer's UUIDv5 entity and event IDs. The per-source-entity
`inventory_import_state` row carries a transaction-scoped fence: equal
coordinate and digest returns the original result, lower offsets are stale, and a
changed generation/topic/partition or equal-coordinate digest conflict is
rejected. Canonical inventory, existing outbox events, audit entries, and the
fence commit together through the tenant-scoped `inventory_app` role.
Site/bin deletes and bin relocation are rejected for quarantine; device
deletion becomes a soft-deleted status. Device serial changes and
saga-managed-device imports are rejected because the v1 event contracts cannot
represent those transitions safely.

Run `make db-migrate`, then `npm test -w services/device-service` with the
repository's local `.env` loaded. The importer consumer, Kafka offset commits,
DLQ/redrive and MySQL connector are separate Stage 10c tasks.

## Cable and sensor inventory (ADR-0027)

The owner API adds `POST /v1/cables`, `GET /v1/cables/{id}`,
`PATCH /v1/cables/{id}`, `DELETE /v1/cables/{id}`, and
`GET /v1/bins/{id}/cables?limit&after`. Viewer/operator/admin can read;
operator/admin can mutate. Creation requires `Idempotency-Key`. Edits and
removals require `If-Match: "<cableVersion>"`; missing preconditions return 428,
stale versions return 412 with the current ETag. Every response includes the
cable version; deleted cable GETs expose the owner tombstone.

Create/edit bodies are `{binId, deviceId, label, sensors}`. Each sensor has
`{label, position, depthM}`: position is a distinct positive integer, depth is
nullable finite nonnegative **meters**, and missing depth remains null. Edits
retain sensor IDs by including `sensorId`; an entry without an ID creates a new
owner-assigned ID, and omitted IDs are retired permanently. IDs from another
cable, tenant or removed sensor cannot be claimed. The API caps each cable at
100 current sensors and each cable-list page at 20 cables to bound transaction
and response work; these are API bounds, not hardware or agronomic thresholds.

A cable requires an active device with a completed agricultural binding to its
bin/site. `assetId` continues to identify physical hardware and is never accepted
as a cable's bin binding. Devices and cables are locked in that order (device
IDs sorted on reassignment), then cable edits compare and increment the supplied
optimistic version. Device moves carry their cables to the new bin; unbinding,
soft deletion and explicit cable removal revoke the layout. Import moves/deletes
use the same owner-event path. Forced RLS, tenant predicates and composite tenant
foreign keys cover both `bin_cables` and `cable_sensors`; runtime identity rewrites
and physical deletes are not granted.

Each change writes `cable.layout_changed` v1, audit and owner state atomically.
The event uses aggregate `cable`, `cable_version`, `operation: upsert|deleted`,
and the complete ordered current sensor list with `depth_m`. Deleted snapshots
contain an empty list. It routes to `greenguard.inventory.sensor-layout.v1`.
The immutable outbox preserves old layout snapshots and their sensor identities;
retired sensor rows remain in the owner database. Telemetry ingest resolves the
snapshot's tenant/device/sensor association and captures layout provenance at
acceptance; projection and telemetry consumers are separate deployment gates.

Focused checks after build:
`node --test dist/inventory/cable-validation.test.js dist/inventory/cables.live.test.js dist/api/cables.http.test.js`.
Run live tests against a migrated disposable database through `inventory_app`.

`GG_MESH_INTERNAL_HTTP=1` permits `CONTROL_LOOKUP_URL` to use HTTP only at a
Kubernetes Service DNS name; JWKS remains HTTPS outside loopback. Enable it
only with injected Istio sidecars, STRICT mTLS, source-specific
AuthorizationPolicy, and default-deny NetworkPolicy that allows the control
lookup peer. Prove plaintext and unauthorized pod traffic is denied in the
live cluster before accepting the deployment.

For Cognito user access tokens, set `AUTH_TOKEN_MODE=cognito-access`,
`AUTH_COGNITO_CLIENT_IDS`, `AUTH_ISSUER`, and `AUTH_JWKS_URL`. The runtime
requires `AUTH_MEMBERSHIP_SOURCE=control-plane`, `CONTROL_PLANE_URL`,
`CONTROL_LOOKUP_TOKEN`, and the membership Redis/Kafka settings used by the
shared membership client. The token's issuer and subject are mapped to tenant
roles by the control plane; tokens with no membership are denied. The default
Dex audience mode remains unchanged.

## Tenant placement routing

Set `SHARD_REGISTRY_FILE` to a private version 1 registry for `service: device-service`, `database: greenguard_inventory`, with all four `s1`–`s4` primaries and their incarnation UUIDs. Set `CONTROL_PLANE_URL` and `CONTROL_LOOKUP_TOKEN` for authenticated placement lookup. Production endpoints require `sslmode=verify-full` and `sslrootcert`; local loopback registries require explicit `SHARD_LOCAL_LOOPBACK=true`. The enabled runtime allocates no legacy database pool and fails closed on missing, stale, inactive or mismatched ownership.

API and saga manifests must use `inventory_app`. Tenant and entitlement projector manifests must use `inventory_projector`; each projector deployment supplies its own private registry through `SHARD_REGISTRY_FILE`. `INVENTORY_DATABASE_URL` / `INVENTORY_PROJECTOR_DIRECT_URL` remain the legacy configuration only when the registry is absent.

Every tenant transaction resolves the verified tenant, sets transaction-local tenant/shard/incarnation/epoch settings and calls `greenguard_internal.admit_tenant_placement` before business SQL. Commands, imports, projections, receipt IDs and outbox IDs retain their existing semantics. Saga result discovery fans out only the existing ID-only SECURITY DEFINER selector, then resolves and admits each tenant before reading/publishing a result. Quiescing tenants retain pending results. Verified entitlement heartbeats update tenant-free feed metadata on every owner primary. Health probes cover all primaries; pool shutdown waits at most five seconds.

### Exact device serial lookup

Authenticated `GET /v1/devices/lookup?serial=<serialNumber>` resolves an exact
serial label to `{deviceId, serialNumber}` using the verified principal's tenant.
Viewer/operator/admin reads are allowed. The owner transaction retains placement
admission and tenant RLS; the application also filters tenant and excludes deleted
records. Serials are bounded to 128 characters, with control characters and extra
query fields rejected. Missing/deleted devices return 404; ambiguity returns 409.
The lookup runs before the UUID route and does not alter bindings or inventory.
