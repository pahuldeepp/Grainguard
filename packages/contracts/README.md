# packages/contracts

Status: **event contracts implemented (Stage 02b)**; HTTP, GraphQL and Protobuf contracts remain planned.

Stages: 02.

Technology: JSON Schema, OpenAPI, GraphQL, Protobuf.

Use: `validateEvent(event)` checks the JSON Schema and the semantic rules (lowercase non-nil UUIDs, exact decimal-string versions, non-zero trace IDs); `outboxRowToEvent(row)` builds the canonical envelope from an outbox row. Schemas live in `contracts/events/`, fixtures in `tests/fixtures/events/`.

Responsibility: Canonical generated contracts and compatibility fixtures.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.
