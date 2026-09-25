# Stage 07 — Durable provisioning and coordination

Status: in progress. Stage 07a's saga database, tenant RLS, idempotent start and first command outbox are implemented and live-tested. The first Stage 07b reserve-success result transition is also implemented and live-tested; participant publication/consumption, later transitions, and the full acceptance gate remain open. Stage 06's score-to-acknowledgement flow passes locally, while remote CI is pending. This plan follows the provisioning flow and acceptance gate in `GREENGUARD_MASTER_PLAN.md`.

## Outcome

`POST /v1/device-provisioning` starts one tenant-scoped provisioning workflow with an idempotency key. The API returns a saga ID and current status. The workflow reserves an asset, configures it, activates the inventory device, and waits for the telemetry binding to become ready. Business provisioning and ingestion readiness remain separate observable states.

```text
requested → reserving → configuring → activating → active
                    ↘ compensating → compensated / repair_required
```

The existing `device.registered` event keeps its Stage 02 meaning. New lifecycle/result events are versioned; existing devices get an explicit migration/backfill rather than an implicit status reinterpretation.

## Slices

1. **Saga authority.** Add a Go `saga-orchestrator` with its own `greenguard_sagas` database, forced tenant RLS, saga state/version, unique `(tenant_id, idempotency_key)`, step attempts, deadlines, command outbox, result inbox, and audit entries. Start/advance/compensate transitions lock or compare the same saga version and commit state plus outgoing commands atomically.
2. **Participant protocol.** Define versioned `asset.reserve`, `asset.configure`, `inventory.activate`, and binding-ready commands/results. Each owner checks tenant, command ID, expected version and fencing token; records an inbox/receipt; changes only its own database; and emits its result through its own transactional outbox. Duplicate commands return the original result.
3. **Compensation and repair.** On bounded timeout or definitive failure, persist cancellation/deactivation commands before publishing. A late success after cancellation is reconciled, never silently accepted. Expose a tenant-scoped status/history API and an audited operator repair/redrive command; distinguish retryable transport failure from a business rejection.
4. **Coordination.** Use PostgreSQL state/version and uniqueness constraints as authority. Exercise Redis or etcd leases for worker assignment, with monotonically increasing fencing tokens checked at every side effect. A stale leader cannot advance a saga or overwrite a newer participant result. Use serializable transactions or explicit optimistic versions for conflicting device/asset assignments and document the chosen invariant.
5. **Security and operations.** Authenticate the API, enforce RBAC and tenant RLS, propagate correlation/trace IDs, use mTLS on service-to-service paths, and expose state counts, step latency, expired deadlines, compensation backlog, and repair-required alerts. Set bounded retry/DLQ policies and runbooks.

## Acceptance gate

- A successful request survives a process restart after every local commit and publish boundary; replay creates no duplicate reservation, activation, or binding.
- Duplicate, out-of-order, late, and conflicting result events cannot skip states or cross tenants.
- A failed configuration/activation drives the right compensations; an unavailable participant leaves durable pending work and later recovers.
- Concurrent requests for the same asset have one winner. An expired lease and stale worker cannot apply a side effect after a newer token takes ownership.
- Test the real Kafka/CDC path, timeout and broker outage, worker SIGKILL/restart, and operator redrive. Record local and CI evidence in `evidence/` before changing the milestone status.

Stage 08 then exposes this lifecycle through the GraphQL BFF and dashboard, including pending/failed/repair states and reconnect-safe status refresh.
