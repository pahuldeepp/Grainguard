# services/telemetry-ingest

Status: **Stages 03a and 03b implemented**: telemetry schema, migrations, device-binding consumer, and the authenticated, rate-limited, traced ingest endpoint with data-quality checks and bounded rejection samples.

Stages: 03.

Technology: Go, gRPC/Protobuf, HTTP, pgx.

Responsibility: Single durable ingest path; reading and outbox in one transaction.

| File                                         | Purpose                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations/`                                | `golang-migrate` SQL for `greenguard_telemetry` (forced RLS, separate migrator and runtime roles); `cmd/migrate` applies it                       |
| `tenant.go`                                  | `WithTenant`: every tenant-scoped query runs in a transaction with a transaction-local tenant                                                     |
| `bindings.go`                                | Device-binding consumer core: idempotent, sequence-checked, inbox de-duplication ([ADR-0005](../../docs/adr/0005-device-binding-consumer.md))     |
| `auth.go`                                    | RS256 token verification with a cached JWKS; roles `viewer`, `operator`, `admin`, `device`                                                        |
| `quality.go`, `ingest.go`, `rejections.go`   | Data-quality rules, the single ingest transaction, and bounded rejection samples ([ADR-0006](../../docs/adr/0006-ingest-quality-and-lateness.md)) |
| `tracing.go`, `correlation.go`, `metrics.go` | OpenTelemetry server spans, correlation IDs and the stored `traceparent`, and rejection counters ([ADR-0004](../../docs/adr/0004-tracing.md))     |
| `ratelimit.go`, `httpapi.go`, `config.go`    | Token-bucket limiter, the HTTP handler (authenticate, limit, validate, ingest) and environment configuration                                      |

Endpoint reference: [docs/INGEST_API.md](../../docs/INGEST_API.md). Rate limiting: [ADR-0007](../../docs/adr/0007-ingest-rate-limiting.md).

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.

## Stage 01 implementation

Local foundation is implemented. See [setup](../../docs/SETUP.md) for commands, current scope and verification. Domain features described above remain planned.

## Stage 04b binding transport

`consumer.go`, `consumer_kafka.go`, `consumer_schema.go` and `consumer_runtime.go`
connect canonical inventory events to the existing ADR-0005 transaction. Set
`KAFKA_BROKERS` to enable group `telemetry-binding-consumer`; unset it to preserve
standalone operation. `EVENT_SCHEMA_DIR` defaults to `../../contracts/events` and
must point to the repository event schemas when launching from another directory.
Readiness includes the database, broker and consumer; a stopped consumer shuts down
HTTP and returns an error for supervisor restart.

One outstanding Kafka record prevents gaps in the commit frontier. Offsets commit
only after database commit or acknowledged quarantine. Schema/key errors and event-ID
conflicts quarantine with bounded original bytes. Version gaps and missing bindings
stop without committing; repair prerequisites before restarting. Transient DB errors
retry five times within a 20-second deadline. Binding/inbox/stream ownership and the
stream-before-binding lock order remain unchanged.

`binding_feed.go` and migration 000004 persist infrastructure checkpoints without
tenant RLS. Their optimistic monotonic offset/source-position conditions fence replay.
`INGEST_BINDING_FEED_MAX_STALE=5m` gates every new observation after receipt replay;
`0` explicitly disables the gate. A stale/missing checkpoint returns
`503 binding_feed_stale` with `Retry-After: 5`. See [ADR-0009](../../docs/adr/0009-binding-feed-freshness.md)
for the connector/transformer heartbeat protocol and fixed partition/clock assumptions.

Tests use scripted transactions and franz-go's pinned kfake virtual network.
Run `GOFLAGS=-mod=mod GOPROXY=off go test -race -cover ./...` with the `.env` database
URLs exported; `make coverage` supplies them through Make. Full database and listener
tests need an unrestricted local test environment. `make events-e2e` runs the live
acceptance separately. [Validation evidence](../../evidence/STAGE_04B_VALIDATION.md)
distinguishes executed checks from unverified integration and coverage gates.

## Stage 07 binding readiness participant

`binding.await` is a separate saga command consumed from
`greenguard.saga.commands.v1`. The command receipt is tenant-scoped and durable
in `saga_binding_requests`. It emits a `succeeded` result only after this
service's own `device_bindings` row is active. An inventory binding event and
any pending readiness receipts complete in one transaction, serialized with
the command insert by a per-tenant/device advisory lock. The result publisher
uses the stable result ID and marks delivery after Kafka confirms; a crash can
redeliver it safely. A missing or disabled binding stays pending until the saga
deadline/repair path resolves it, rather than inventing a business rejection.

The opt-in worker requires `SAGA_BINDING_ENABLED=1` and `KAFKA_BROKERS`
(group `telemetry-saga-binding-v1`, override `SAGA_BINDING_GROUP`). It finds
tenants with unpublished results through the ID-only SECURITY DEFINER selector
`saga_binding_result_tenants(after, limit)` (migration 000007), then publishes at
most 10 results for each of at most 100 tenants per pass, round-robin, inside
each tenant's RLS transaction. The retired `SAGA_BINDING_TENANT_IDS` is rejected
at startup. The receipt table also needs a retention/archival
policy tied to the saga's terminal state before production-scale operation;
pending receipts are intentionally retained while an outcome is unknown.

## Stage 09b machine credentials

When `CONTROL_PLANE_URL` and `CONTROL_LOOKUP_TOKEN` are configured together,
ingest accepts `gg_` API keys and short-lived OAuth client-credentials tokens.
The control plane verifies each credential and supplies the tenant context.
Device keys can write only their bound device, and the existing binding feed
still checks whether that device is active. `INGEST_KEY_RATE` and
`INGEST_KEY_BURST` set the per-key bucket; it is checked with device and tenant
buckets before parsing a reading. A control-plane outage fails closed with 503.

Before credential verification, the ingest route applies a bounded per-socket-peer
token bucket and limits concurrent JWT/JWKS, API-key, and M2M verification calls. Saturation
returns `429` with `Retry-After`. The peer identity comes from the TCP `RemoteAddr`;
forwarded headers are ignored by default. Set `INGEST_TRUSTED_PROXY_CIDRS` to a
comma-separated allowlist of at most 64 proxy CIDRs (universal prefixes are rejected) to bucket by the client address
from `X-Forwarded-For`; only requests whose socket peer is in that allowlist use the
header. The ingress must overwrite it with the verified client IP or append the
verified IP as the rightmost hop. Missing or malformed chains fall back to the
socket peer. These application limits are a fallback: internet-facing deployments
must also configure per-source-IP rate limiting at the trusted WAF or ingress before
traffic reaches this service. The local staging Compose stack
keeps telemetry-ingest private and does not publish its port; do not expose it
directly as a public service. See [ADR-0007](../../docs/adr/0007-ingest-rate-limiting.md)
and the [exposure runbook](../../docs/runbooks/telemetry-ingest-exposure.md).

## ADR-0027 additive telemetry v2 (production emission gated)

The existing endpoint accepts the unchanged flat v1 temperature/RH payload. A
v2 request explicitly adds `schema_version: 2`, optional independent `co2_ppm`
and `grain_moisture_percent`, and `measurement_units` describing exactly the
actual scalar values. Units are `Cel` for `temperature_c`, `%` for air RH and
grain moisture, and `ppm` for CO2. Null input values are absent. Percentages
are 0–100, CO2 is nonnegative and finite with no invented upper limit, and
temperature keeps the existing -80–120 acceptance range. These are physical
acceptance rules, not calibrated agronomic thresholds.

Optional `sensor_observations` carries `{sensor_id, metric, value, unit}`.
Each sensor/metric pair is unique (at most 256 observations within the existing
16 KiB body bound). The client cannot supply layout metadata. In the durable
reading/receipt/audit/outbox transaction, the service resolves the sensor by
verified tenant, authenticated device, and current bin binding. It attaches
`cable_id`, `layout_version`, ordered `position`, and nullable `depth_m` from the
local owner snapshot. Unknown, removed, or differently associated sensors fail
closed. A retained receipt is returned before current binding/layout checks,
so a replay never changes original sample provenance or IDs.

Migration 000012 adds nullable independent fields, immutable sample provenance,
and a forced-RLS `cable_layout_bindings` replica. The binding consumer also
consumes `cable.layout_changed` v1 from
`greenguard.inventory.sensor-layout.v1`, storing its inbox and complete snapshot
atomically with monotonic versions. Gaps hold the source offset. Owner snapshots
are serialized by a tenant/cable advisory lock; ingest holds a share lock while
resolving layout, after the existing stream and binding locks.

`INGEST_TELEMETRY_V2_ENABLED` defaults to `0`; only `1` enables new v2 writes.
Disabled writes return `503 telemetry_v2_disabled` with `Retry-After: 5`; already
accepted receipts can still replay. Set this gate only after v2 schemas are
registered and risk/projection/history live, replay and reference consumers
support the contract. CDC publishes v2 to `greenguard.telemetry.recorded.v2`
and preserves v1 routing. The device binding heartbeat remains the existing
feed freshness guard; a dedicated sensor-layout freshness heartbeat is not
implemented in this slice.
