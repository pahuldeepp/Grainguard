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
