# Stage 09f feature flags — validation (2026-09-25)

## Delivered

- `packages/feature-flags` evaluates typed OpenFeature defaults from a verified tenant context. Tenant and global snapshots are versioned; an older event cannot replace a newer one. Provider errors, stale snapshots and type mismatches use code defaults and report stale scope.
- `flag_configurations` and append-only `flag_configuration_audit` have forced tenant RLS. The control-plane `PUT /v1/organizations/:tenantId/flags` requires a verified active admin, Idempotency-Key and If-Match. It writes the snapshot, actor audit and `flag.configuration_changed` outbox row in one transaction. The matching authenticated internal snapshot endpoint supports authoritative freshness renewal. Global snapshots use the reserved infrastructure tenant `00000000-0000-4000-8000-000000000001` because the control-plane outbox requires a non-null tenant ID; a dedicated platform token and configured operator identity guard global writes, and their audit records retain that actor. Tenant admins cannot reach the global write route.
- The notification consumer reads `greenguard.platform.config.v1`, reconnects after startup failure, and refreshes unchanged tenant snapshots through the internal endpoint at most once per 30 seconds. Fetch timeout is 2 seconds; failures retry after 5 seconds. Once the last good snapshot exceeds 60 seconds, the typed default disables optional sends. A disabled optional send stays in the retry queue with its original body and intent ID; no provider call or ledger terminal state is created. Critical sends remain independent of this optional-work flag.
- The event schema is registered in the TypeScript contracts and Go CDC transformer. The `notifications.optional_sends` flag defaults to false.

## Executed checks

| Check | Result |
|---|---|
| `npm test --prefix packages/feature-flags` | 7 passed; global sentinel event, F01 tenant isolation, F02 outage/type default, F03 stale alert, monotonic event consumer, forged-context rejection. |
| `npm test --prefix services/notification-service` | 32 passed, 0 failed with `.env` and live Postgres; no skipped tests. Includes F04 retry preservation, startup outage to recovery, unchanged-snapshot renewal, global fallback, tenant override and stale fallback. |
| `npm run coverage --prefix packages/feature-flags` | 7 passed; 92.53% statements, 74.50% branches. |
| `npm run coverage --prefix services/notification-service` with `.env` | 32 passed; 92.17% statements, 91.32% branches. |
| `npm run migrate --prefix services/tenant-control-plane` with `.env` | `20260925140000_flag_configurations` and `20260925141000_global_flags` applied to local `greenguard_control`. The global seed migration sets the infrastructure RLS context during insertion. |
| `node --test services/tenant-control-plane/dist/flags/flags.live.test.js` with `.env` | F01/F05/F06 passed against local Postgres and HTTP. Tenant B cannot mutate A using a forged header; A's change creates one audit and one outbox row; a replay creates no duplicate; uncredentialed internal snapshot request gets 401; tenant B runtime role sees no A row; emitted event validates against the contract. |
| `node --test services/tenant-control-plane/dist/flags/*.live.test.js` with `.env` | Platform token writes a global snapshot; a tenant admin token receives 401; one actor audit and outbox event are produced; event contract validates; a customer runtime tenant cannot read the global row. |
| `node scripts/stage09f-flags-e2e.mjs` with local Kafka, Debezium, RabbitMQ and Postgres | Passed twice. A fresh tenant had audited flag v1 enabled and v2 disabled via HTTP; Debezium/CDC delivered both to Kafka; a warning task was sent when enabled and held in the retry queue when disabled, with no ledger row; an older version replay was ignored and the next task stayed held. Each held test task was removed from the retry queue after verification. |
| `npm run typecheck --prefix services/notification-service` and `npm run typecheck --prefix services/tenant-control-plane` | Passed after the 09f code changes. |

## Local runtime command

`bash scripts/stage09f-notifications-live.sh` starts the control plane on `127.0.0.1:18098` and the notification worker on `127.0.0.1:18096` after the local Kafka/RabbitMQ stack and database migrations are ready. It explicitly sets `KAFKA_BROKERS` (default `127.0.0.1:59092`) and `CONTROL_PLANE_URL`, and loads `CONTROL_LOOKUP_TOKEN` from `.env`. A smoke run returned control `/readyz` and notification `/healthz`; the Kafka flag consumer joined all six `greenguard.platform.config.v1` partitions. The separate `node scripts/stage09f-flags-e2e.mjs` command exercises the complete flag and optional-send transport path with an isolated test tenant.

## Remaining stage-wide checks

Stage-wide `make verify`, full coverage, Sonar and CodeRabbit are owned by the Stage 09 gate integrator. The local Kafka and RabbitMQ path passed; a destructive broker outage/recovery test was not run. Startup outage/recovery has a deterministic consumer test. The notification runtime requires `KAFKA_BROKERS`, `CONTROL_PLANE_URL` and `CONTROL_LOOKUP_TOKEN` to receive and renew live flag state. With no configuration it remains at the safe default.

## Review fixes: kill-switch precedence and poison flag events (2026-09-25)

- A global rule with `locked: true` is authoritative and cannot be overridden by a tenant snapshot (`VersionedFlagStore.resolve`). `FLAG_REGISTRY` lists tenant-settable keys and types; tenant `PUT` of an unknown, mistyped or `locked` flag returns 422 `flag_not_allowed`, and the platform credential may write only registered keys.
- The notification flag consumer quarantines poison events (`bad_envelope`, `schema_invalid`, `key_mismatch`, `unknown_flag_key`) to `greenguard.quarantine.v1` with `reason_code`/`tenant_id` headers (`unknown` when unvalidated) and commits past them. A failed quarantine publish propagates, so the offset is not committed. Tenant snapshots (LRU, default 10,000, expired entries swept) and the gate's refresh map (LRU) are bounded.
- Tests: `packages/feature-flags` (11 pass, 1 live skip), `services/notification-service` (22 pass), `services/tenant-control-plane` flag live tests (4 pass). Not run: live Kafka, whole control-plane suite (other in-flight edits fail `tsc`).
