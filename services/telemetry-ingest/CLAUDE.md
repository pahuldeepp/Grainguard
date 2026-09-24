# telemetry-ingest (Go, pgx)

Owns `greenguard_telemetry`: device bindings, streams, readings, receipts, outbox, audit, inbox. Never writes inventory tables.

- Test: `go test -race ./...` · Coverage: `make coverage` from repo root · Format: `gofmt -l .` must print nothing.
- Endpoint behaviour: `docs/INGEST_API.md`; design: `docs/FIRST_VERTICAL_SLICE.md` section 4 (SQL) and 5A (ingest transaction), tests I01–I05; ADR-0005, 0006, 0007.
- Lock order is stream row `FOR UPDATE`, then binding `FOR SHARE`. Keep it identical in every code path.
- Reading, outbox, receipt and audit commit in one transaction. No Kafka or HTTP call inside it.
- `WithTenant` (`tenant.go`) is the only way to run tenant-scoped SQL: it validates the tenant UUID, sets `app.tenant_id` with `set_config(..., true)` inside the transaction, and always rolls back on error or panic.
- Keep `run(ctx, getenv)` and `newPool` injectable so every path stays testable at 100%.
- Test HTTP clients must disable keep-alives, or `Shutdown` waits on idle connections and tests flake under `-race`.
- Order on the ingest path: authenticate, rate limit, parse and validate, then one transaction. A rejection returns a stable reason (`Reason*` constants in `types.go`), is counted, and never becomes a reading.
- Runtime traffic goes through PgBouncer: pgx uses `QueryExecModeExec`; migrations use the direct owner URL. Provisioning of roles and databases is idempotent (`infra/compose/init-databases.sql`, re-run by `make db-up`).
- Token verification never reads the tenant from a header or body. Device tokens (`device` role, subject is the device ID) may write only their own device.
- Sonar fails functions above cognitive complexity 15 and string literals repeated more than 3 times; split functions and use constants.
