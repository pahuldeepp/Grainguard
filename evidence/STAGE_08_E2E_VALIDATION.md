# Stage 08 live browser E2E validation

Date: 2026-09-25. Local, uncommitted checkout; remote CI has not run. Command:
`make browser-e2e` (opt-in, never in `verify`), script `scripts/browser-e2e.mjs` with
`scripts/browser-e2e-stack.mjs`. Passing run: 2026-09-25T06:37:44Z, 101 s, all 27 checks.
Log: [stage08-e2e/browser-e2e.log](stage08-e2e/browser-e2e.log) (tokens redacted); run
report: [stage08-e2e/report.md](stage08-e2e/report.md); per-process logs and screenshots
are in `stage08-e2e/`.

## What ran for real

- Real Chromium (Playwright 1.63, browsers already installed) running a private production
  build of the dashboard. It is served like `apps/dashboard/nginx.conf`: SPA fallback plus
  `/graphql` proxied to the BFF, on `http://localhost:5173` (bound to `[::1]`, a Dex-registered
  redirect URI).
- Dex authorization code + PKCE for alice (admin, tenant A), victor (viewer, tenant A) and bob
  (operator, tenant B). Memberships come from `infra/oidc/memberships.json`.
- BFF → saga API directly with the user's Dex bearer. The saga API now maps membership through
  `AUTH_MEMBERSHIP_FILE`. Also running: the saga worker, hardware worker with the MQTT
  signed-ack fixture, the device-service inventory participant and the telemetry participant.
- Ingest with a device token → Debezium CDC → cdc-transformer → projection-builder (read
  Postgres), cassandra-writer (Cassandra) and search-indexer (a private Elasticsearch alias).
  Reads go BFF → Read API with the user's token. The Read API uses the Redis Cluster cache.
  The 48 h-old reading also went through the normal ingest path (`INGEST_MAX_AGE` 168 h). The
  Cassandra test hook was not used.

## Results (from the log)

| # | Scenario | Result |
|---|----------|--------|
| 1 | UI start with Idempotency-Key, durable polling | PASS: badges reserving → configuring → active; history requested, reserved, configured, activated, binding.ready |
| 2 | Reload mid-provisioning, sign in again, repeat Start | PASS: URL `?saga=` restored, state refetched (configuring); same key and saga; 1 saga row for the device |
| 3 | Hardware worker down → repair → admin redrive | PASS: reserving → compensating → repair required; viewer redrive `insufficient_role`; UI redrive → compensated, `operator.replay` audited |
| 4 | Current, recent (Postgres), older (Cassandra), search (ES) | PASS: 18.25 °C/61.5 % current; 1 recent row; 12.5 °C 48 h-old row with Read API `source=cassandra`; search hit |
| 5 | Tenant B and viewer isolation | PASS: bob search empty; GraphQL device/latest null, history 0, saga `not_found`; A's device URL → not found; A's saga URL → `not_found`; victor Start hidden, API `insufficient_role` |
| 6 | Accessibility smoke | PASS: 0 serious/critical on sign-in, home, provisioning, devices; ARIA snapshots in `stage08-e2e/a11y-*.aria.yml` |
| 7 | Loading, Read API 503, recovery | PASS: `role=status` "Searching devices…"; BFF pointed at a dead Read API port → friendly error while provisioning still works; recovery restores search |

## Defects found and fixed (dashboard/BFF, with unit tests)

1. The idempotency key lived only in a React ref, so a reload plus a repeated Start sent a new
   key. It is now stored in `sessionStorage` per identity/device/asset (`idempotencyKeyFor`).
2. The tracked saga was lost on reload. It is now kept in the `?saga=` URL and
   `sessionStorage`, and the sign-in round trip returns to the original URL.
3. Viewers saw Start and redrive controls. The BFF now has a `session { subject tenantId roles }`
   persisted query, and the panel hides Start for viewers and redrive for non-admins. The API
   still enforces roles.
4. Read errors showed raw codes (`upstream_unavailable`). They now show a friendly
   "temporarily unavailable" message.

## Defects for other owners

- The saga API rejected Dex bearers because it had no membership mapping, which contradicted
  ADR-0014 ("BFF forwards the same bearer"). The saga owner fixed this during this run (now
  `AUTH_MEMBERSHIP_FILE`). Probe: HTTP 404 for an unknown saga with a Dex token.
- `services/device-service` does not build: `src/saga/results.live.test.ts(97)` has
  `cursorBase` undefined, from work in progress. The run used the existing `dist`.
- The shared Cassandra container exited with code 137 during one attempt (external). The
  cassandra-writer then exits with no retry and needs a restart.
- The fixed Kafka group `greenguard.hardware.v1` is shared, so this gate cannot run
  concurrently with `stage07-e2e`.

## Not verified

axe-core (not installed; a custom rule set plus Playwright ARIA snapshots were used instead);
bob's redrive of A's saga stops at the role gate (operator) before any tenant check; the
reconnect test relies on a full reload because there are no live subscriptions yet; Redis
cache hit ratios were not asserted; remote CI; Sonar; CodeRabbit.
