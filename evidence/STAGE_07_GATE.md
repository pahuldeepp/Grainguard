# Stage 07 acceptance gate: ledger and local live evidence

Date: 2026-09-24. Checkout: `main` at `176f449` plus uncommitted work from several
agents. Remote CI has **not** run on this state. Stage 07 is not marked complete here;
the coordinator updates `docs/MILESTONES.md` from this evidence.

## 1. Ledger before this session (from code inspection and a baseline run)

| Item                                                                                                                                                                                                                                                                                     | State found                                                        | Evidence                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Slice 1: saga authority (forced RLS, idempotent start, asset claim, outbox, inbox, audit)                                                                                                                                                                                                | Implemented and tested                                             | `STAGE_07A_VALIDATION.md`, `saga/store_live_test.go`                                        |
| Slice 2: participant protocol (`asset.reserve/configure/release` in `hardware-service`; `inventory.activate/deactivate` in device-service; `binding.await` in telemetry-ingest). Each owner checks tenant, command ID, version and fence, keeps a receipt and uses its own result outbox | Implemented and tested per service                                 | `hardware-service` live tests, `make inventory-saga-test`, telemetry `saga_binding_test.go` |
| Slice 3: compensation on **rejection**; status/history API; audited operator redrive                                                                                                                                                                                                     | Implemented                                                        | `transition_live_test.go`, `repair_live_test.go`, `cmd/api`                                 |
| Slice 3: compensation on **timeout**                                                                                                                                                                                                                                                     | Missing. A deadline only quarantined the saga as `repair_required` | `deadline.go` (old)                                                                         |
| Slice 3: reconcile a late success after cancellation                                                                                                                                                                                                                                     | Missing. It was sent to the DLQ as stale                           | `result.go` (old)                                                                           |
| Slice 4: leases, fencing tokens on side effects, bounded assignment                                                                                                                                                                                                                      | Missing. Static `SAGA_TENANT_IDS`, no lease or fence               | `cmd/worker` (old)                                                                          |
| Slice 5: API auth/RBAC/RLS                                                                                                                                                                                                                                                               | Implemented. mTLS, metrics, alerts and runbooks are **open**       | `cmd/api`                                                                                   |
| E2E: two tenants, Kafka/CDC, MQTT ack, one coordinator restart, duplicate result, inventory rejection                                                                                                                                                                                    | Existed and passed (baseline, 72 s)                                | `stage07/STAGE_07_BASELINE_UNIT.log`; first run of `scripts/stage07-e2e.mjs`                |
| Gate items: SIGKILL at every boundary, timeout, broker outage, unavailable participant, stale lease, redrive, concurrent asset                                                                                                                                                           | Not exercised live                                                 | —                                                                                           |

## 2. Implemented in this session

- `migrations/000005_shard_leases.up.sql`: 64 `saga_shard_leases` rows with monotonic
  fencing tokens; a `saga_dispatch_tenants` registry with forced RLS; an ID-only
  `saga_shard_tenants` SECURITY DEFINER selector. The concurrency choice is documented
  in the migration. No DELETE grants.
- `saga/lease.go`: `Leases.Renew/Check/Release`, `ShardFor`, `TenantsWithWork`.
  `Store.Fence` is checked inside the publish and deadline transactions.
- `saga/deadline.go`: a timed-out forward step moves to `compensating`, committing
  `asset.release` or `inventory.deactivate` before any publish. A timed-out
  compensation becomes `repair_required`.
- `saga/result.go`: a late result for a superseded version is recorded as
  `late_result.reconciled` and never advances the saga.
- `cmd/worker`: leased, bounded shard scanning. `SAGA_TENANT_IDS` is rejected at
  startup.
- device-service `inventory.ts`: `inventory.deactivate` of a never-activated device
  is a successful no-op. Timeout compensation during `activating` needs this.
- [ADR-0013](../docs/adr/0013-saga-coordination.md) (PROPOSED): PostgreSQL leases
  instead of Redis.
- `scripts/stage07-e2e.mjs`: added gate phases (below). The workers use leases
  (TTL 3 s) and their own result group.

## 3. Results (commands run in this session)

| Gate bullet                                                                                                                                                                                               | Result        | Log                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------- |
| `go test -race ./...` saga-orchestrator (25 tests incl. lease takeover, in-flight fence, timeout compensation, late reconciliation, redrive)                                                              | PASS          | `stage07/STAGE_07_SAGA_GO_TEST.log` |
| `make inventory-saga-test` (incl. new no-op deactivate)                                                                                                                                                   | PASS, 2/2     | run output in session               |
| Full gate run twice (`node scripts/stage07-e2e.mjs`); both exit 0. Final run in `STAGE_07_GATE_E2E.log`, first in `STAGE_07_GATE_E2E_run1.log`                                                            | PASS          | both                                |
| Two-tenant success through Kafka, Debezium CDC and the MQTT signed ack; coordinator restart; duplicate Kafka result; cross-tenant 404                                                                     | PASS          | `stage07/STAGE_07_GATE_E2E.log`     |
| Concurrent requests for one asset: codes `[202,409]`, one set of effects                                                                                                                                  | PASS          | same                                |
| SIGKILL of saga worker, hardware, inventory and telemetry at every new saga version (v1 to v4; 16 kills). Exactly one command, receipt, reservation, activation, `device.registered` and binding per step | PASS          | same                                |
| Unavailable participant: reserve published, 0 results while hardware is down; recovers to active                                                                                                          | PASS          | same                                |
| Configure timeout (no ack) drives `deadline.compensate` then `asset.released`, asset `available`                                                                                                          | PASS          | same                                |
| Inventory rejection drives asset release (baseline phase)                                                                                                                                                 | PASS          | same                                |
| Compensation timeout to `repair_required`, operator redrive via API (cross-tenant redrive 404), late reserve reconciled, one release receipt                                                              | PASS          | same                                |
| Expired lease: worker A SIGSTOPped, B takes the shard and the token rises from 66 to 67, A logs `lease lost; side effect refused` after SIGCONT, no duplicate effects                                     | PASS          | same                                |
| Broker outage: Kafka container paused 8 s mid-provisioning; no process restart needed; active with no duplicates                                                                                          | PASS          | same                                |
| `make verify`                                                                                                                                                                                             | PASS (exit 0) | `stage07/STAGE_07_VERIFY.log`       |

## 4. Bugs found and decisions to review

1. **Open bug (hardware-service):** after a timeout compensation releases an asset
   whose `asset.configure` is still pending, the configure receipt stays `pending`
   (`configureReceipts: {"pending":1}` in the log). The MQTT dispatcher skips it on every
   poll, and its selector returns at most 100 rows, so orphans can starve newer
   configurations. Fix: finalize pending configure receipts in the release transaction.
   This is outside this session's scope.
2. **Decision:** PostgreSQL leases instead of Redis (ADR-0013). This deviates from the
   plan's "Redis or etcd" wording and needs owner approval.
3. **Decision:** results are not lease-fenced. They are protected by Kafka group
   generation plus the saga row lock, version and fence.
4. The device-service and telemetry participant workers still use explicit tenant
   lists for their result outboxes.

## 5. Still open for Stage 07

- Remote CI on this change. No `make coverage` or Sonar run was done in this session.
- Slice 5: mTLS, state/latency/backlog metrics, repair-required alerts, runbooks.
- Participant tenant lists must be replaced with ID-only selectors (item 4 above).
- The hardware pending-configure bug (item 1 above).
- Production MQTT TLS, ACLs and per-sensor key provisioning; multi-broker Kafka.

## 6. Follow-up session (2026-09-25): see [STAGE_07C_VALIDATION.md](STAGE_07C_VALIDATION.md)

- Item 1 (hardware pending-configure bug): **closed**. The release cancels the pending receipt. The dispatcher is fair and bounded (skip-locked, 100 per pass) and was tested with over 100 orphans. The e2e timeout phase now shows `configureReceipts: {"cancelled":1}`.
- Item 4 (participant tenant lists): **closed**. ID-only selectors, round-robin and bounded, with the retired env vars rejected at startup.
- Slice 5: metrics, `/metrics`, alert rules, runbooks, command trace context and an RBAC test matrix are **done**. **mTLS is still open.**
- The earlier `saga-test` failure did not reproduce in 6 runs (3 of them under parallel DB load).
- The gate rerun passed (exit 0). `make verify` fails only at Prettier on another agent's `services/bff` files; the per-step results are in the 07c evidence.
