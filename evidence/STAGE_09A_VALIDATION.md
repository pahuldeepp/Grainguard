# Stage 09a validation — 2026-09-25

Update (2026-09-25): M09 process-crash test passed against the local control
database: `STAGE09_CRASH_LIVE=1 node --env-file=.env --test
services/tenant-control-plane/dist/domain/crash.live.test.js` after building the
control plane yielded **1 passed, 0 failed**. The test killed a writer before
commit while its outbox insert was paused, observed zero durable effects, then
killed the caller immediately after commit and observed the organization,
membership, two audit rows, two outbox rows and receipt exactly once. The saved
output is [stage09a-crash-live.log](stage09a-crash-live.log).

Status: control-plane and verifier library implemented and locally validated.
BFF, Read API, gateway and saga API runtime switches are wired. The platform-wide
09a exit gate is **open** until live Kafka/CDC propagation and end-to-end Dex
revocation are measured; tenant projection cutover also remains.

## Implementation and security

- `greenguard_control` owns organizations, tenantless IdP identities, invitations,
  versioned active/revoked memberships, append-only audit, receipts and outbox.
- Revocation records `revoked_at`, `revoked_by` and version +1. Invitation acceptance
  can reactivate a revoked membership and clears both revocation fields. A membership
  change, audit row and canonical `membership.changed` event commit in one transaction.
- Forced RLS and application tenant filters protect every tenant table. Runtime
  `control_app` cannot DELETE or UPDATE audit/outbox/receipts. An identity lookup
  is read-only and scoped with `app.identity_id` set transaction-locally.
- The membership event contains a hashed identity ID, role, state, action, version
  and effective time. Raw issuer, subject, invitation token and email are absent.
  Its strict schema and semantic checks are in `contracts/events` and
  `@greenguard/contracts`.
- The verifier checks the OIDC token before lookup, caches positive results for 30 s
  and negative results for 5 s, and fails closed after 5 min without a successful
  refresh. A revoked result returns 403. The Redis Cluster version store atomically
  advances decimal bigint floors, so duplicate and reordered events cannot lower a
  floor or make a delayed older lookup authoritative.

## Executed checks

| Command/check | Result |
|---|---|
| `npm run migrate -w @greenguard/tenant-control-plane` with local `.env` | Passed; two migrations found, no pending migrations |
| `npm run typecheck -w @greenguard/membership-client` | Passed |
| `npm run typecheck -w @greenguard/tenant-control-plane` | Passed |
| `npm test -w @greenguard/contracts` | 22 passed, 0 failed |
| `npm run coverage -w @greenguard/membership-client` | 15 passed, 0 failed; 100% statements, 94.33% branches |
| `npm run coverage -w @greenguard/tenant-control-plane` with local PostgreSQL/PgBouncer | 26 passed, 0 failed; 98.95% statements, 89.47% branches |
| Redis Cluster live monotonic-floor probe using six local Redis nodes | Passed: version `9007199254740994` survived a later duplicate/older `9007199254740993` event |
| 09a-focused live suite after scoped CodeRabbit fixes (API, store, migrations, main, seed) | 25 passed, 0 failed; includes keyset pagination, caller-bound idempotency and RLS |
| Live index inspection | Passed: `memberships_identity_idx` is non-partial and includes revoked rows |
| `coderabbit review --uncommitted --include-untracked --dir services/tenant-control-plane --agent` | Completed with four findings; all addressed (identity lookup index, strict body keys, bounded member pagination, caller-bound receipts) |

The control-plane suite exercised API cross-tenant denial, PostgreSQL RLS isolation,
tenant-scoped composite keys, runtime role privileges, invitation replay and expiry,
concurrent last-admin and version conflicts, and DB-backed revoke/lookup. Its
revoke → committed outbox read → cache invalidation → 403 measurement was **21.8 ms**
in the coverage run. This measures the local test path, not CDC propagation p95/max.
The no-event path denied at the 30-second cache boundary in a deterministic clock
test. Cache outage tests denied after 5 minutes.

## Not yet proven

- M06 across four running HTTP services after one committed control-plane
  mutation, including a propagation p95/max. Route-level 403 tests and the
  committed DB → CDC → Kafka → two-verifier live check below pass; the live
  check provides two local latency samples, not a latency distribution.
- M09 process-crash injection before/after commit passed in the 2026-09-25
  update above. A separate live check proves publication through CDC for a
  committed revocation.
- M10 device-service tenant projection convergence and removal of direct tenant
  writes, M11 empty-to-upgrade migration, and the opt-in Dex + BFF end-to-end flow
  remain. No real Auth0 tenant is required for these local checks.
- `make verify`, Sonar and CodeRabbit are whole-tree gates and are not claimed here.
  The scoped CodeRabbit review is complete. A later combined control-plane test run
  included concurrent 09b changes and reported 23/30 passing before 09b fixes; those
  failures covered 09b API keys/config plus 09a fixed-list assumptions and one 09a
  test count. The 09a-focused rerun after correcting those assumptions passed 25/25.

No external credentials or account actions were used.

## Runtime verifier wiring (2026-09-25)

The BFF, Read API and gateway now select the `@greenguard/membership-client`
verifier with `AUTH_MEMBERSHIP_SOURCE=control-plane`; `file` remains the default
for Stage 08 tests. Each control-plane process uses a Redis membership-version
store and an independent Kafka consumer group on
`greenguard.inventory.tenant.v1`. The consumer awaits Redis floor advancement
and local invalidation before committing its offset. The saga Go API applies the
same verified-token-first lookup order, 30-second positive/5-second negative
TTL, 5-minute stale bound, tenant-scoped Redis floor and canonical event
invalidation. It returns `403 insufficient_role` for a revoked membership.

Focused route tests reused the *same still-valid signed JWT* before and after a
`membership.changed` event. BFF, Read API, gateway and saga each admitted the
active member and returned 403 after revocation. The signed token's forged
tenant and admin claims did not override first-party membership. The saga
cache test also covered two tenants, a foreign-tenant event, duplicate and
reordered versions, and outage denial after the stale bound.

| Command | Result |
|---|---|
| `npm run typecheck -w @greenguard/bff -w @greenguard/read-api -w @greenguard/gateway` | Passed |
| `npm test -w @greenguard/membership-client` after runtime review fix | 16 passed, 1 opt-in live test skipped, 0 failed |
| `npm test -w @greenguard/bff -w @greenguard/read-api -w @greenguard/gateway` | BFF 34 passed; Read API 31 passed, 1 existing live test skipped; gateway 8 passed; 0 failed |
| `go test ./cmd/api` in saga-orchestrator | Passed |
| `go test -race ./cmd/api` in saga-orchestrator | Passed |
| `coderabbit review --dir packages/membership-client --include-untracked --agent` | One valid malformed-record finding received and fixed; review connection then closed before verdict, so the review gate is incomplete |

The route tests call the verifier with in-process membership lookup fixtures
and invoke the canonical event handler directly. A separate live check below
covers committed CDC delivery. A running four-service HTTP propagation p95/max
and whole-tree gates remain before closing 09a.

The subsequent live CDC check exercised the real local path: a committed
`revokeMember` transaction and outbox row in PostgreSQL, the running Debezium
connector, a dedicated rebuilt CDC transformer, the canonical Kafka topic,
and two independent Redis-backed verifier replicas. The same signed JWT was
valid before the mutation and returned 403 from both replicas **723 ms**
after commit in the saved run (an earlier run measured 1,224 ms); a user in a
second tenant remained accepted. Exact command:
`STAGE09_MEMBERSHIP_CDC_LIVE=1 node --env-file=.env --test services/tenant-control-plane/dist/runtime.live.test.js`
after `npm run build -w @greenguard/tenant-control-plane` and starting the
transformer with `KAFKA_BROKERS=127.0.0.1:59092`, a unique `KAFKA_GROUP_ID`, and
`EVENT_SCHEMA_DIR=contracts/events`: **1 passed, 0 failed**. The dedicated
transformer process was stopped after the check. This is one local latency
sample, not a p95/max measurement or a running four-service HTTP check.
The saved output is [stage09a-runtime-cdc-live.log](stage09a-runtime-cdc-live.log).
