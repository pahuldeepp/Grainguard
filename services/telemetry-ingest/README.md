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
