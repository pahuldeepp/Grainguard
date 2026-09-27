# Stage 09c validation (2026-09-25)

Work in progress. Exact commands/results will be recorded after the billing event projectors and migrations are exercised against the local stack.

- Shared entitlement store and decoder: 3 tests passed.
- Device inventory ENT-01/02/05: 2 live database tests passed. D01 migration drift check passed.
- Control-plane ENT-08/API key quota: 2 live database tests passed. Existing store/API key tests: 16 passed.
- Telemetry ingest: `go test ./...` passed; ENT-07 live quota test passed; malformed tenant key test passed.
- Read API history range: 1 test passed; BFF GraphQL denial mapping: 1 test passed.

## Entitlement freshness fix (2026-09-25, ADR-0022)

Defect: paid plans fell back to free limits five minutes after their last plan change. Tests were written first and failed for the stated reason (limit fell back to the free default):

- Red: `TestENT10PaidPlanAppliedAnHourAgoStillHonored` (Go, live Postgres): "the one-hour-old plan limit must still apply, got <nil>". Control-plane `ENT-10` failed with the same cause. Device-service `ENT-10` was rewritten because its first form could not discriminate (the free default 10 exceeds the test limit), then confirmed against the fix.
- Green after `entitlement_feed_health` migrations, `entitlement_feed_fresh()` in all four consumers and the heartbeat projectors:
  - telemetry-ingest `go test -race -run 'ENT|Heartbeat'`: ENT07, ENT10 (old plan honored), ENT11 (stale feed uses free default; heartbeat restores the plan), ENT12 (heartbeat monotonic, no plan row rewritten), TestParseHeartbeat all PASS.
  - tenant-control-plane: 103 pass, 0 fail (includes ENT-10, ENT-11, ENT-12 with two tenants and a stale-version replay that cannot regress a plan).
  - device-service: ENT-01/02, ENT-05, ENT-10, ENT-11, ENT-12, D02 pass. Two failures remain that are not from this change: D01 (Prisma drift: index on `audit_events(tenant_id, occurred_at, audit_id)` from the audit-export migration) and "receipt, outbox event and audit record share one command ID" (shared test tenant reaches the free 10-device limit).
  - read-api: 35 pass (new live ENT-10/11 and ENT-12 pass against `greenguard_read`).
  - `packages/entitlements`: 7 pass (`EntitlementStore` honors an unchanged plan across 60 heartbeats, fails closed only when stale, a lagging partition keeps it stale).
  - billing-service: 36 pass including the new every-plan-defines-every-limit test (red first: standard and enterprise inherited free defaults).
  - `npm run lint` and `npm run typecheck` clean.
- Not verified: the heartbeat producer against a live broker, and the Go and Node projector loops receiving a heartbeat from Kafka (unit tests cover decode and apply; no live Kafka was used). Full `go test ./...` in telemetry-ingest also had two environmental failures (`too many clients already` from Postgres while other suites ran; `TestMainShutsDownOnSIGTERM`), not investigated.
