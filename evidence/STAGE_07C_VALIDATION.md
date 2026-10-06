# Stage 07c: participant hardening and slice 5 (minus mTLS)

Date: 2026-09-25. Checkout: `main` at `176f449` plus uncommitted work from several
agents. No commit, no remote CI, no `make coverage` and no Sonar run in this session.
Stage 07 is not marked complete here; the coordinator owns `docs/MILESTONES.md`.

## Changes

| Item | Change | Tests |
| ---- | ------ | ----- |
| Hardware pending-configure bug | `asset.release` cancels the saga's pending `asset.configure` receipt in the same transaction (new `cancelled` outcome). Migration `000003` repairs existing orphans, adds `last_dispatched_at`, and replaces the selector with `hardware_pending_configuration_ids(p_limit)`, which returns IDs only, is clamped to 100 and ordered least-recently-dispatched first. The dispatcher claims each receipt with `FOR UPDATE SKIP LOCKED` in the tenant's RLS transaction, cancels orphans on claim and moves blocked receipts to the back. A replayed configure whose receipt is `cancelled` publishes no result. | `TestLiveReleaseCancelsPendingConfigure`, `TestLiveDispatcherNeverStarvesNewConfigurations` (110 orphans plus 110 blocked; the fresh configuration was dispatched on pass 3), `TestLiveSelectorClampsBatchAndReturnsIDsOnly`, `make hardware-mqtt-test` (live Mosquitto) |
| Participant tenant lists | device-service migration `20260924080000` adds `inventory_saga_result_tenants(after, limit)`. Telemetry migration `000007` adds `saga_binding_result_tenants(after, limit)`. Both are SECURITY DEFINER loose index scans that return tenant IDs only, backed by an owner-only, read-only scan policy. Workers take a keyset round-robin cursor over at most 100 tenants and at most 10 results per tenant per pass, inside each tenant's RLS transaction. They consume every tenant's commands under that tenant's RLS on fixed groups. `INVENTORY_SAGA_TENANT_IDS` and `SAGA_BINDING_TENANT_IDS` are rejected at startup. | `results.live.test.ts` and `TestBindingResultTenantDiscoveryIsIDOnlyBoundedAndFair`: 120 tenants, one of them heavy, all reached in 3 passes; no result under a foreign key; no duplicates; the runtime role counts 0 rows without tenant context. Also retired-env tests |
| Metrics | Saga migration `000006`: count-only `saga_state_metrics()` and `saga_pending_command_metrics()`. `saga.Metrics`: `saga_state_count{state}`, `saga_repair_required`, `saga_compensation_backlog`, `saga_deadline_overdue`, `saga_commands_pending`, `saga_commands_oldest_pending_seconds`, `saga_lease_lost_total`, `saga_deadlines_expired_total`, commands published, results applied and quarantined, and `saga_step_latency_seconds{step}`. No tenant or saga labels. `/metrics` on the worker (`SAGA_METRICS_ADDR`) and on the API. | `TestLiveMetricsAreAggregateAndTenantFree` (output has no UUIDs), `TestMetricsHandlerMethodAndFailure`, `TestServeMetricsReportsListenerFailureAndStops`, `TestMetricsRouteIsServedWithoutTenantAuth` |
| Alerts and runbooks | `docs/runbooks/saga-alerts.rules.yml` (6 rules) plus 6 runbooks, each with symptom, diagnosis commands, mitigation and escalation. Retry and DLQ bounds are documented in the participant-down runbook. | Not checked with `promtool`, which is not installed |
| Trace context | Commands carry `correlation_id` (saga ID) and a W3C `traceparent`: trace ID = saga ID, parent span = first 16 hex digits of the command ID. It is carried in the body and in Kafka headers. Hardware results echo the headers. This matches device-service `eventContext`. | `TestLiveMetrics...` (published command), `TestCommandHeadersCarryTraceContext`, `TestResultHeadersCarrySagaTraceContext` |
| RBAC | Added a matrix: viewer cannot start or redrive, operator cannot redrive, and unknown methods return 404. | `TestRBACDeniesEachRouteBelowItsRole` |
| Saga test flake | Not reproduced: 3 serial runs and 3 runs alongside the hardware and telemetry suites all passed. | session output |

## Commands run

- `go test -race ./...` passed in hardware-service, saga-orchestrator and telemetry-ingest (saga and binding tests).
- `node --test` passed for device-service `results.live` and `inventory.live`.
- `node scripts/stage07-e2e.mjs`: exit 0, every gate phase PASS. The timeout phase now reports `configureReceipts: {"cancelled":1}`, where it used to report `pending`. Log: [stage07/STAGE_07C_GATE_E2E.log](stage07/STAGE_07C_GATE_E2E.log).
- `make verify`: exit 2 at `npm run format:check`, because Prettier flags `services/bff/src/main.ts` and `services/bff/src/schema.ts`. Those files belong to another agent and were not touched here. The remaining verify steps were run individually: [STAGE_07C_VERIFY_REST.log](stage07/STAGE_07C_VERIFY_REST.log) and [STAGE_07C_VERIFY_RERUN.log](stage07/STAGE_07C_VERIFY_RERUN.log).

## Decisions to review

1. The traceparent is derived deterministically from the saga and command IDs; there is no live span. CLAUDE.md says not to invent trace IDs when tracing is on. This follows the existing device-service convention, but it should become the live span once the saga worker is instrumented through `@greenguard/otel`.
2. `/metrics` on the API is unauthenticated. It serves aggregate counts only, and the API binds to loopback unless mTLS is enabled.
3. Cancelled configure receipts publish no saga result, because the saga already superseded that step.
4. The e2e `broker` phase still pauses the shared Kafka container for 8 s. That phase already existed in the script and was not changed in this session.

## Still open

Remote CI; mTLS; promtool validation and Stage 11 alert wiring; participant-side metrics endpoints (hardware, inventory, telemetry binding); a live-span traceparent; the Stage 14 runbook rehearsal.
