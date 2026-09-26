# Runbook: integrity invariant alerts

**Severity:** page. **Alerts:** `IntegrityCDCQuarantined`, `IntegrityProjectionQuarantined`, `IntegrityJobsDLQPublishFailed`.
**Owner:** the owning service on-call. These are zero-tolerance invariants, not percentage SLOs; see [SLOs](../SLOS.md) section "Non-SLO invariants".
**Dashboard:** "GreenGuard - SLO Burn Rates (proposed)" panel "Firing integrity alerts (must be zero)".

## Symptom

An accepted event was isolated or could not be parked durably. Nothing is lost while the source row, quarantine record or database job row still exists, but the event is not flowing until resolved.

## Diagnosis

1. `sum by (reason) (increase(cdc_quarantined_total[1h]))` for the quarantine reason; `increase(projection_quarantined_total[1h])`; `increase(jobs_dlq_publish_failed_total[1h])`.
2. Read the quarantine record or DLQ entry (the identifier lives in logs and the quarantine table, never in a metric label) and correct the cause: schema or contract mismatch, poisoned payload, broker unavailable.
3. See [streaming backlog](streaming-backlog.md) for CDC and consumer state.

## Mitigation

Fix the cause, then replay or redrive the specific event with the documented tooling (idempotent by event ID). Never delete the quarantined record to silence the alert.

## Escalation

Escalate to the platform owner if any event cannot be reconstructed from its source-of-record. That is a data-loss incident.

## Verification

The increase returns to zero, the event appears downstream, and the alert resolves.
