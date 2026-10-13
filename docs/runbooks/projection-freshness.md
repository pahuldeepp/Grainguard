# Runbook: projection freshness unknown or breached

**Severity:** ticket for missing measurement; page when freshness breach affects a critical user journey.  
**Signals:** projection freshness, checkpoint age, CDC/Kafka lag, projector errors.

## Triage

1. Confirm the freshness metric is present and its source timestamp is advancing. Missing data means unknown, not fresh.
2. Compare source connector progress/WAL slot age, Kafka consumer lag/oldest age, consumer errors, checkpoint age, and projection apply duration.
3. Follow a sampled event trace across outbox, CDC, broker, and projection. Use bounded event/trace context in access-controlled tools only.
4. Check for schema quarantine, poison events, paused partitions, database saturation, and a blocked connector. Preserve offsets and committed work; do not skip or truncate to clear lag.
5. Restore the blocked component or use the approved replay/rebuild procedure with idempotent receipts.
6. Verify lag drains faster than incoming work, checkpoints advance, end-to-end freshness returns to baseline, and alert resolves.

## Recovery and evidence

Reconcile accepted source IDs with applied projection receipts, record any quarantined events, and attach sanitized lag/freshness evidence.

## Alert names

- `ProjectionFreshnessUnknown`
- `ProjectionPendingRecords`
