# services/saga-orchestrator

Status: **Stage 07a authority implemented; participant wiring is pending**.

Stages: 07.

Technology: Go, Postgres, Kafka.

Responsibility: Durable provisioning state machine, retry and compensation.

The `greenguard_sagas` PostgreSQL database is owned by `saga_migrator`; the
`saga_app` runtime role has no table ownership or RLS bypass. All four saga
tables force tenant RLS. `saga.Store.Start` runs in one tenant transaction:
it claims the asset, creates a `reserving` saga, queues `asset.reserve`, and
records `provisioning.requested`. A repeated idempotency key returns the same
snapshot only when the device and asset match. The partial unique asset index
allows one active or repair-required claim per tenant and asset; two racing requests cannot both
win. The state version and fencing token start at 1 and will guard subsequent
row-locked transitions. Command publication, result handling, API auth, retry,
compensation and operator repair are the next slices; no end-to-end provisioning
claim is made yet.

Local checks: `make saga-migrate` then `make saga-test` with `SAGA_DIRECT_URL`
from `make bootstrap`. The live tests prove one saga/command/audit transaction,
idempotent retry, changed-payload conflict, tenant and unscoped RLS denial, and
one winner for a concurrent asset claim.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.
