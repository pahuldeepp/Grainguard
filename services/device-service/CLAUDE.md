# device-service (NestJS, Prisma 7)

Owns `greenguard_inventory`: tenants, sites, bins, devices, command receipts, outbox, audit.

- Test: `npm test -w services/device-service` · Coverage: `npm run coverage -w services/device-service`.
- Tests use `node:test` against compiled `dist/`; add new files as `src/*.test.ts`.
- Config comes from `src/config.ts` `readConfig(env)`; keep env parsing there, not in `main.ts`.
- Design to implement: `docs/FIRST_VERTICAL_SLICE.md` sections 2, 4 (inventory database) and "Inventory binding contract"; tests D01–D03.
- Always query through `withTenant` (`src/db/tenant.ts`); keep an explicit `tenant_id` filter too. Prisma 7 runs through `@prisma/adapter-pg` over PgBouncer; migrations use the direct owner URL from `prisma.config.ts`.
- Locking follows `docs/adr/0002-concurrency-control.md`: raw `FOR UPDATE` via `$queryRaw` inside `withTenant`, always bounded by `lock_timeout` or `NOWAIT`.
- Database tests need `.env` exported; run them through `make verify` or `set -a; . ./.env`. New migrations: see this service's README.
- Device creation writes device, receipt, audit and outbox in one transaction.
