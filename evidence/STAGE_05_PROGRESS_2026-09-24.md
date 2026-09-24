# Stage 05 local integration checkpoint — 2026-09-24

This checkpoint records tested behavior in the current uncommitted working tree;
it does not mark Stage 05 complete or establish production capacity.

- `make verify` passed after formatting `services/device-service/src/inventory/repository.ts`.
- With the local PostgreSQL stack running, the projection-builder's live
  `TestDatabase|TestWithTenantDoesNotLeak|TestRunAppliesMigrations|TestMainSucceeds`
  selection passed under `go test -count=1 -race` with `.env` loaded. Migration
  `000002_history_retention.up.sql` was applied by `make verify`.
- `make cassandra-up` started healthy local Cassandra and applied its schema.
  `make cassandra-test` passed duplicate-upsert, cross-tenant row/watermark and
  watermark-read checks under `go test -count=1 -race`.
- Cassandra writer's unit test verifies write, watermark and offset-commit order;
  failures before the commit leave the offset uncommitted. Its offline tests are
  now included in `make verify`.

Still unverified: an end-to-end Kafka-to-Cassandra replay, process kill/restart,
quarantine publish failure, out-of-order watermark semantics, Stage 04 final
fault gate, search indexing, replay/rebuild and 05e API routing. A passing local
Compose profile does not certify the ten-million-customer target.
