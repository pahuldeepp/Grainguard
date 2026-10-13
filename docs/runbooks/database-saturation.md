# Runbook: database pool saturation or slow queries

**Severity:** page when user latency/error SLO or write acceptance is threatened.  
**Signals:** pool pending/usage, connection failures, lock waits, deadlocks, slow-query fingerprint.

## Triage

1. Identify the owning service and pool; compare active, idle, pending, max, and acquisition wait.
2. Inspect bounded query fingerprints, duration, calls, lock waits, transaction age, and Postgres resource pressure. Never include raw SQL parameters in dashboards or tickets.
3. Check for a deployment, fan-out, retry storm, or consumer concurrency increase that drove load.
4. Reduce the source of excess concurrency or roll back the causative change. Increase pool/database capacity only after confirming the database can sustain it.
5. Preserve tenant RLS and transaction boundaries; do not kill unknown sessions or disable timeouts without a reviewed action.
6. Verify pool wait and latency recover, no accepted work was lost, and alerts resolve.

## Recovery and evidence

Record query fingerprint, service, safe plan evidence, mitigation, and recovery. Route query improvements to the owning service with representative explain plans.

## Alert names

- `PostgresClientPoolWaiters`
- `PostgresPoolExhaustion`
- `PostgresSlowQueryRateHigh`
