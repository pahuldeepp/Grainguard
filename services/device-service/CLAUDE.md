# device-service (NestJS, Prisma planned)

Owns `greenguard_inventory`: tenants, sites, bins, devices, command receipts, outbox, audit.

- Test: `npm test -w services/device-service` · Coverage: `npm run coverage -w services/device-service`.
- Tests use `node:test` against compiled `dist/`; add new files as `src/*.test.ts`.
- Config comes from `src/config.ts` `readConfig(env)`; keep env parsing there, not in `main.ts`.
- Design to implement: `docs/FIRST_VERTICAL_SLICE.md` sections 2, 4 (inventory database) and "Inventory binding contract"; tests D01–D03.
- Prisma behind PgBouncer: runtime URL uses `pgbouncer=true`, migrations use a direct URL. Set tenant context with `set_config(..., true)` inside the same `$transaction` as the queries. Prisma has no `FOR UPDATE` API; use raw SQL inside the transaction. See `docs/ARCHITECTURE_REVIEW.md` P4 and R2.
- Device creation writes device, receipt, audit and outbox in one transaction.
