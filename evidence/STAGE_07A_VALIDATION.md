# Stage 07a saga authority — 2026-09-24

`make saga-migrate` applied the forward-only saga schema to the local
`greenguard_sagas` database. `make saga-test` exited 0 against the runtime
`saga_app` role. The tests exercised duplicate and changed-payload idempotency
keys, a single saga/command/audit effect, tenant B and unscoped read denial,
two concurrent claims for one asset with exactly one winner, and two simultaneous
retries of the same key resolving to one saga. A cross-saga result cannot borrow
another saga's command ID. The store
keeps the saga, command outbox and audit write in one transaction.

The scoped CodeRabbit review found command/result identity, repair-state claim,
bounded test-context and same-key race issues. A forward migration and focused
tests resolve them. The integrated `make verify` and `make coverage` runs pass.
The final local Sonar gate passed with 89.5% coverage, 0.0% duplication and zero
violations. Remote CI has not run on this slice yet.

This is the authority foundation only. No participant has consumed an
`asset.reserve` command yet. The API, result inbox transitions, compensation,
fenced leases, real Kafka/CDC path and crash matrix are required for Stage 07.
