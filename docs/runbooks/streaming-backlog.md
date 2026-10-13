# Runbook: Kafka, CDC, RabbitMQ, or DLQ backlog

**Severity:** page when backlog age threatens freshness or durable capacity; otherwise ticket with owner.  
**Signals:** lag/depth, oldest age, consumer progress, WAL retention, retries, DLQ.

## Triage

1. Determine affected transport, topic/queue/group, partition skew, oldest age, producer rate, drain rate, and remaining storage/WAL headroom.
2. For CDC, inspect connector task state, source last-progress time, slot retained WAL bytes/age, schema quarantine, and broker availability.
3. For Kafka, inspect consumer failures/rebalances, partition skew, processing/commit latency, and downstream DB saturation.
4. For RabbitMQ, inspect ready/unacked, consumer count, redelivery, publisher confirms, retry and DLQ state.
5. Restore the failed consumer/dependency, then scale only within partition and downstream capacity. Admission shedding must protect WAL/disk before exhaustion.
6. Do not reset offsets, delete queues, purge DLQ, or invalidate replication slots without the approved recovery/reconciliation procedure.
7. Confirm drain rate exceeds arrivals, backlog age falls, accepted identities reconcile, and alerts resolve.

## Recovery and evidence

Save sanitized before/after lag, WAL, retry, and reconciliation evidence. Quarantined records require explicit disposition.

## Alert names

- `CDCCommitLagGrowing`
- `DebeziumConnectorMissing`
- `DebeziumConnectorDisconnected`
- `DebeziumSourceLagHigh`
- `JobsDispatchLagHigh`
