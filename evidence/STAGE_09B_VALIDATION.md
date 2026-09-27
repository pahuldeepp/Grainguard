# Stage 09b validation — machine and API authentication

Date: 2026-09-25. Implementation is in the control plane, tenant-auth package,
telemetry ingest, and versioned event contract. ADR-0018 records the digest and
revocation choices.

## Implemented

- Tenant-scoped service principals, API keys and OAuth clients in `greenguard_control` with forced RLS, non-owner runtime grants, global uniqueness of issuer/client pairs, and narrowly granted public-ID resolver functions.
- 256-bit random API keys; only a peppered HMAC-SHA-256 digest is stored. The secret is returned once on issuance/rotation. Scopes are bounded by the creator's active role; device keys bind to one device and `write:telemetry`. Expiry, revocation, rotation overlap, creator revocation, organization suspension, and safe last-used metadata are enforced.
- Admin HTTP issuance/list/rotation/revocation; internal credential verification protected by the service lookup token. Every credential state change and its outbox event commit together. Lifecycle events contain only tenant/principal ID, version and state.
- RS256 OAuth client-credentials verifier against configured issuer/JWKS, audience, expiry, `iat`, client-grant marker, maximum 15-minute token lifetime, allowed and required scopes. The verified issuer/client resolves to exactly one first-party tenant. An IdP-supplied `tenant_id` is ignored. Enterprise M2M is the preferred integration path.
- Telemetry ingest forwards machine credentials to the control plane, fails closed on control-plane outage, binds device keys to the request's device, and checks key/device/tenant token buckets atomically before parsing. Both mechanisms yield `{tenant_id, principal_id, principal_type: "service", scopes}`; API keys also carry key/device IDs.
- The BFF, Read API and gateway now call the control plane for machine credentials. BFF permits only persisted telemetry read operations for service principals; Read API independently requires `read:telemetry`; gateway denies service principals provisioning and subscription tickets. Both API keys and OAuth machine JWTs use the same first-party tenant context. A machine key gets its own Redis token bucket in the BFF, checked atomically with the tenant and principal buckets.

## Executed checks and exact results

- `npm run migrate -w @greenguard/tenant-control-plane` with local `.env`: 09b migrations applied successfully to `greenguard_control`.
- `npm test -w @greenguard/tenant-auth`: **42 passed, 0 failed**. Includes live local JWKS, RS256/issuer/audience/expiry/scope checks, rejection of user-grant tokens and ignored tenant claims.
- `npm test -w @greenguard/contracts`: **22 passed, 0 failed**. The 09b schema also validates committed outbox events in the live control-plane suite.
- `npm test -w @greenguard/tenant-control-plane` with local `.env`: **35 passed, 0 failed, 1 skipped**. Includes live PostgreSQL tenant isolation, digest-only persistence, concurrent rotation (one successor), idempotent issuance/rotation, immediate revocation, creator removal, OAuth global uniqueness, HTTP issuance and internal OAuth verification, safe metadata, RLS, lifecycle event validation, and a real Go ingest admission process calling a live Nest control plane for two tenants before and after key/OAuth revocation. A token carrying tenant B while mapped to tenant A resolved to A. The skipped test is 09a's separate CDC/Kafka multi-verifier live path.
- `go test -race ./...` in `services/telemetry-ingest`: **all packages passed**. Includes key/device binding and per-key limiter fairness.
- `npm test -w @greenguard/tenant-auth -w @greenguard/bff -w @greenguard/read-api -w @greenguard/gateway`: **45/45, 36/36, 32/33 (one pre-existing opt-in live-backend skip), 9/9 passed**, respectively. New checks cover owner verification, machine scope denial, BFF per-key bucket identity, Read API tenant derivation, and gateway mutation/subscription denial.
- `node --env-file=.env scripts/stage09b-machine-e2e.mjs`: **passed**. This starts a real Nest control plane backed by local PostgreSQL, the actual gateway, BFF GraphQL server and Read API. An API key in tenant A and an OAuth M2M JWT mapped to tenant B both reach the correct tenant through GraphQL and direct Read API routes. A forged tenant header and a wrong tenant claim do not change the mapping. Insufficient scope returns 403; key and OAuth client revocation each make the next request return 401. The harness creates isolated tenant IDs. One local run of 100 sequential owner lookups measured **p95 3.78 ms**; this is a development-machine latency sample, not a production-load SLO result.
- `node --env-file=.env --test --test-concurrency=1 "services/tenant-control-plane/dist/**/*.test.js"`: **35/36 passed, one opt-in CDC/Kafka skip** after the new 09b wiring; no failures. `go test -race ./...` in ingest passed again. Scoped Prettier and ESLint checks passed for the new machine boundary code.

## Not yet proven or external dependencies

- No real Auth0 tenant is configured here. The owner must register an Auth0 M2M API/client, set `CONTROL_M2M_*` and run a real issued-token check. Local signed JWKS tests cover the protocol behavior.
- The Go ingest cross-process test reaches the real admission function and real Nest control-plane routes, stopping before a durable telemetry write; the existing ingest tests cover durable writes separately. The new GraphQL/gateway/Read API test uses real service HTTP processes and a lightweight in-memory read backend, not live Cassandra or Elasticsearch.
- The ingest per-key limiter is process-local, consistent with ADR-0007. Credential lookup p95 under target production load was not measured. We deliberately use owner lookup on every request instead of an L1 cache to keep revocation immediate; ADR-0018 records the tradeoff.
- The BFF now enforces a Redis per-key bucket, but its fixed initial budget is pending 09c entitlement-driven policy. The ingest per-key bucket remains process-local, so horizontal production enforcement and load-target p95 still need later distributed policy/performance work.
- The plan's device-key revocation binding-feed optimization is replaced here by an owner lookup on every request. The binding feed still enforces device state; control-plane failure returns 503. This behavior is recorded in ADR-0018.
- The combined `make verify`, Sonar and CodeRabbit gates are owned by the root Stage 09 run and are not claimed here.

## Review fixes F2 (2026-09-25): lookup token, key scopes, machine tenant binding, replay

Design: [ADR-0020](../docs/adr/0020-machine-client-tenant-binding.md). Real local results:

- `npm run test -w @greenguard/tenant-auth`: **49 passed, 0 failed** (new tenantClaim test).
- Control plane, run as `tsc -p .` then `node --test --test-concurrency=1 "dist/**/*.test.js"` (the package `npm test` build step currently fails on another fixer's `src/entitlements/projector.ts`): **91 passed, 7 failed**. The 7 failures are outside F2's files (six audit-worker S3W1-S3W6 tests and the migration RLS test on the new `entitlement_feed_health` table); all F2 tests (`config`, `domain/api-keys`, `api/api-keys`) pass.
- New coverage: lookup token >= 32 bytes; machine issuer allow-list and tenant-claim config; demoted creator's key/client lose scopes; two tenants registering one client id (A still resolves to A, B to B, no or wrong tenant claim resolves to nothing, HTTP 401); identical replay of create/rotate/revoke, different-body conflict, lost create response recovery, failed create leaves no receipt; missing org and non-member both 403.
- Not run: `make verify`, Sonar, the live Go/gateway end-to-end scripts (`stage09b-machine-e2e.mjs` and `machine-ingest.e2e.test.ts` were edited to send the tenant claim but not re-run here).
