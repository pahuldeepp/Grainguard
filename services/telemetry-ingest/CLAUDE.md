# telemetry-ingest (Go, pgx)

Owns `greenguard_telemetry`: device bindings, streams, readings, receipts, outbox, audit, inbox. Never writes inventory tables.

- Test: `go test -race ./...` · Coverage: `make coverage` from repo root · Format: `gofmt -l .` must print nothing.
- Design to implement: `docs/FIRST_VERTICAL_SLICE.md` section 4 (SQL) and section 5A (ingest transaction), tests I01–I05.
- Lock order is stream row `FOR UPDATE`, then binding `FOR SHARE`. Keep it identical in every code path.
- Reading, outbox, receipt and audit commit in one transaction. No Kafka or HTTP call inside it.
- Keep `run(ctx, getenv)` and `newPool` injectable so every path stays testable at 100%.
- Test HTTP clients must disable keep-alives, or `Shutdown` waits on idle connections and tests flake under `-race`.
