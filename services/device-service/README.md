# services/device-service

Status: **Stages 02a and 02b implemented; Stage 06a-0 grain-lot placement added locally**: inventory data layer plus the authenticated, versioned HTTP API ([API reference](../../docs/API.md)).

Technology: NestJS, Prisma 7 (`@prisma/adapter-pg`), PostgreSQL, PgBouncer.

Responsibility: authoritative owner of tenants, sites, bins, grain lots, bin occupancy intervals and devices (`greenguard_inventory`), with command receipts, an immutable outbox and an append-only audit log.

## Data access

| Connection                                                | Role                                                | Used by                      |
| --------------------------------------------------------- | --------------------------------------------------- | ---------------------------- |
| `INVENTORY_DATABASE_URL` (PgBouncer, transaction pooling) | `inventory_app`: not owner, no BYPASSRLS, no DELETE | runtime and tests            |
| `INVENTORY_MIGRATION_URL` (direct)                        | `inventory_migrator`: owns the tables               | `prisma migrate deploy` only |

- Every tenant query goes through `withTenant` (`src/db/tenant.ts`), which sets `app.tenant_id` with `set_config(..., true)` inside the transaction. RLS is forced on all nine tables; queries also filter on `tenant_id`.
- Composite keys keep references inside one tenant, and a device's bin inside the device's site.
- Creating a site or bin requires `Idempotency-Key` and writes its version-1 `site.changed` / `bin.changed` event, audit and command receipt atomically. Receipt retries use a transaction-scoped advisory lock; future edits use optimistic `version` comparison/increment. Facility events carry correlation, causation and trace context and route to `greenguard.inventory.facility.v1`.
- Registering a device writes the device, its `device.registered` outbox event, an audit record and an idempotency receipt in one transaction.
- Placing a grain lot locks its bin row, closes the previous half-open occupancy interval, inserts a new version, and writes `lot.changed`, audit and receipt in one transaction. A GiST exclusion constraint forbids overlapping intervals. `lot.changed` is keyed by tenant and bin on a dedicated topic, preserving bin-version order. Each version needs the lot/occupancy context; a future risk consumer selects the interval covering the reading's `observed_at`. The current command supports one lot per bin at a time; empty-bin retirement and historical corrections are still pending.
- Concurrency rules: [ADR-0002](../../docs/adr/0002-concurrency-control.md).

## HTTP API

`/v1` sites, bins, grain lots and devices with RS256 bearer tokens (`@greenguard/tenant-auth`), `Idempotency-Key`, `ETag`/`If-Match`, header-based `API-Version` with `Deprecation`/`Sunset`, problem+json errors and correlation IDs. Configure with `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL` (all three or none) and optionally `API_VERSION_POLICY`, `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_TRACES_SAMPLE_RATIO`. Details: [docs/API.md](../../docs/API.md), [ADR-0003](../../docs/adr/0003-api-versioning.md).

## Commands

```bash
make db-migrate                              # start Postgres + PgBouncer, apply migrations
npm test -w services/device-service          # needs the .env variables; `make verify` exports them
npm run coverage -w services/device-service
```

Schema changes: edit `prisma/schema.prisma`, add a new numbered folder under `prisma/migrations/` (generate the base with `prisma migrate diff`, then append RLS, grants and checks by hand). The D01 test fails if migrations and the schema drift apart.
