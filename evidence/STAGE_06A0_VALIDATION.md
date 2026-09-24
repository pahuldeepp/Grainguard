# Stage 06a-0 grain-lot foundation (local)

`device-service` now owns tenant-scoped grain lots and versioned, half-open bin occupancy intervals. Migrations `20260924020000_grain_lots`, `20260924030000_lot_fk_names` and `20260924040000_grain_lot_tenant_fk` add forced RLS, runtime grants, tenant-aware foreign keys and a GiST no-overlap constraint, then align the Prisma foreign-key names. A placement takes a bounded bin row lock, closes the previous interval, inserts the new lot/occupancy, and commits `lot.changed`, audit and idempotency receipt in one transaction. The source event uses a bin aggregate/version so all occupancy changes for one bin share a Kafka key.

Local validation completed:

- `make db-migrate`: migrations applied on the existing local database.
- `make verify`: passed, including formatting, lint, type checks, 112 device-service tests, empty-database migration/drift, Go race tests and builds.
- `node --env-file=.env --test services/device-service/dist/api/api.test.js`: 13/13 passed, including admin-only placement and validating the resulting outbox row against the strict shared contract.
- `cd services/cdc-transformer && go test ./...`: passed, including raw-inventory `lot.changed` mapping to the dedicated `greenguard.inventory.lot.v1` topic and rejection from raw telemetry.
- `make events-up`: provisioned the six-partition lot topic; the existing inventory and telemetry CDC connectors were running.
- `node scripts/lot-events-e2e.mjs`: passed with live wheat and canola placements, proving outbox → Debezium → transformer → `greenguard.inventory.lot.v1`, Kafka key `tenant_id:bin_id`, consecutive versions and the previous-lot link. The repeatable command is `make lot-events-e2e`.

This establishes the owner and live canonical transport. The Risk Engine's local lot projection and event-time join, plus the empty-bin/retirement command, remain Stage 06 work. The live test does not claim a deployed Risk Engine or a multi-broker production fault gate.
