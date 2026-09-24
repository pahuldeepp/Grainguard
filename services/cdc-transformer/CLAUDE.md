# cdc-transformer (Go, franz-go)

Owns no database. Consumes raw immutable outbox CDC and publishes canonical events
or confirmed quarantine before committing the source offset.

- Test here: `go test -race -cover ./...`; static checks: `go vet ./...`.
- Match shared JSON Schemas and TypeScript validator; never derive tenant from
  source metadata, message key or headers. Add fixture parity tests for changes.
- Keep `Source`, `Sink`, `SchemaSet`, `run(ctx,getenv)` and client/listener seams.
- Exactly one record is processed at a time. No auto-commit or unacknowledged skip.
- Event identity, origin trace and deterministic bytes survive retry/snapshot.
- Processor deadline must remain below the blocked-rebalance timeout.
- Tests use kfake.VirtualNetwork (no listening TCP sockets or external services).
- Keep cognitive complexity <=15 and repeated string literals in constants.
- Design: FIRST_VERTICAL_SLICE.md section 5B, E01–E05; ADR-0005 and ADR-0008.
- 100% Go statement coverage is not evidence of live transport correctness or a
  separate branch-coverage measurement. Never exclude source files to pass gates.
