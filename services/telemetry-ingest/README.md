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
