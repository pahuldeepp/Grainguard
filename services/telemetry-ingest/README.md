# services/telemetry-ingest

Status: **planned scaffold; implementation not started**.

Stages: 03.

Technology: Go, gRPC/Protobuf, HTTP, pgx.

Responsibility: Single durable ingest path; reading and outbox in one transaction.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.

## Stage 01 implementation

Local foundation is implemented. See [setup](../../docs/SETUP.md) for commands, current scope and verification. Domain features described above remain planned.
