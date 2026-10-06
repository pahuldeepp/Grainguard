# ADR-0028: Telemetry retention, analytics, and durable archive

Status: Accepted architecture; implementation and live acceptance pending  
Date: 2026-10-03

## Decision

GreenGuard uses each store for a distinct purpose:

| Store | Purpose | Retention rule |
| --- | --- | --- |
| Telemetry PostgreSQL write database (`greenguard_telemetry`) | Canonical accepted readings, idempotency receipts, transactional outbox, audit, and consumer bookkeeping | No automatic deletion based on Cassandra or ClickHouse copies. Each table needs its own approved recovery, deduplication, privacy, and audit horizon before a cleanup job is enabled. |
| PostgreSQL read model (`greenguard_read`) and its read replicas | Recent operational projections and hot dashboard reads | Read API uses an eligible replica first; a freshness-sensitive request may fall back to the read-model primary. Only projected telemetry-history partitions are candidates for pruning. Never prune by writing directly to a replica. |
| Cassandra | Device history for application cold-history queries | Current writer applies `HISTORY_TTL` (default 365 days). Cassandra is not indefinite storage unless that TTL is explicitly configured and validated for the deployment. |
| ClickHouse | Derived analytics, reporting, trends, and aggregate queries | Analytics copy only. The existing ClickHouse profile is a local synthetic-data lab with a 90-day TTL, not a production archive or application source of truth. |
| S3 | Durable replay/recovery archive of canonical telemetry events | Archive retention is a separate policy. Do not expire source events until archive integrity, replay, and recovery requirements are approved and proven. |

The intended event path is:

```text
Sensor → telemetry write DB transaction (reading + outbox + audit + receipt)
       → Debezium/Kafka canonical event
          ├→ projection builder → PostgreSQL read model → read replica(s)
          ├→ Cassandra history writer
          ├→ ClickHouse analytics sink
          └→ S3 immutable/replayable event archive
```

The 24-hour hot-window boundary controls query routing, not deletion. The Read API serves recent history from a configured PostgreSQL read replica when its watermark satisfies the request; it uses the read-model primary when freshness admission requires it. Older history is served from Cassandra. Replication lag means “replica only” is not a safe rule for every request.

## Required pruning gates

1. The only PostgreSQL telemetry history eligible for routine pruning is the read-model copy (`reading_history` and its aligned sensor-history projection). The write database's canonical `readings`, `outbox_events`, `audit_events`, `ingest_receipts`, and inbox/deduplication state are outside this job.
2. A read-model partition is eligible only after its exact expected reading identities and event-time range are verified in Cassandra, a configured late-arrival/grace period has elapsed, and the proof is durably recorded. A per-device latest Kafka offset alone is not a complete partition proof.
3. The proof must be checked by the read-model maintenance operation before it drops a partition. If proof is unavailable, inconsistent, or expired, retain the partition and report the condition.
4. A replica follows the read-model primary. Pruning runs once against the owning read-model database; it must not issue deletes independently to replicas.
5. Source-side cleanup is a separate future operation. It requires a durable S3 archive manifest/checksum, a replay test from S3, Kafka/CDC recovery bounds, and independent table-specific retention decisions. A Cassandra or ClickHouse copy alone never authorizes source deletion.
6. ClickHouse retention is not a substitute for S3 durability. Before ClickHouse is used for production analytics, the Kafka sink must have stable event identity, replay-safe/deduplicated writes, checkpoint visibility, and parity/reconciliation evidence.

## Current repository state and gaps

- Telemetry ingest already commits the canonical reading, outbox event, audit event, and receipt in one transaction. Debezium captures inserts from the outbox.
- The read-model partition maintainer is scheduled declaratively every ten minutes. Before this change it dropped `reading_history` / `sensor_reading_history` by age without a Cassandra completeness gate. Migration `000026` now leaves expired partitions in place while continuing to create future partitions; deploying that migration is required to make existing environments fail closed.
- Cassandra records per-device/topic/partition confirmed offsets after a row write and applies a TTL. Those offsets do not prove that every row in a PostgreSQL day partition exists in Cassandra.
- ClickHouse currently exists only as a local synthetic lab. Its seed path writes separately to ClickHouse and Kafka; it has no production sink, archive checkpoint, or parity gate.
- S3 currently backs audit exports and Terraform state. No telemetry-event archive or replay pipeline is implemented.
- There is no routine retention job for canonical telemetry source rows, outbox, audits, receipts, or inbox state. Do not add one until its policy and recovery evidence exist.

Until Cassandra partition verification is implemented and wired into pruning, read-model partition dropping remains disabled by migration `000026`; do not infer completeness from elapsed time or consumer health alone. Existing environments must apply the migration before relying on this protection.

## Acceptance gates before enabling each cleanup

- Read-model pruning: event-level Cassandra parity for every candidate partition; delayed/out-of-order events and Cassandra outage tests; proof expiry/forgery tests; job skips on any uncertainty; partition-drop test against disposable data; read replica follows the owning database change.
- S3 archive: encrypted private bucket, least-privilege producer, object checksums and immutable manifest/commit marker, deterministic replay, duplicate handling, lifecycle/versioning, and Terraform destroy coverage for the disposable environment.
- ClickHouse sink: Kafka-driven ingestion, event-ID deduplication, replay/backfill, parity checks against source manifests, tenant-filtered queries, analytics TTL, and explicit production deployment evidence.
- Source PostgreSQL cleanup: table-specific policy review, archived replay test, retained audit/idempotency guarantees, and an independently gated maintenance role. No global “older than N days” deletion.
