# Optional Flink risk integration

The checked-in deployment is disabled. `RISK_FLINK_ANOMALIES=off` is the default; the Flink Compose profile is opt-in and the Kubernetes job is suspended. No production enablement is approved by local test results.

## Enablement gate

Require passing risk/alert tenant and replay regressions, the complete live notification test, checkpoint recovery tests, CodeRabbit review and CI. Review migration lock times and replay-ledger growth on representative data. Preserve a database backup and a deployment rollback version that understands the new migrations. The local v1 scoring policy does not certify a different calibrated policy from another branch.

Apply risk migrations in order through 000011 before starting an opted-in consumer. Migrations 000005–000011 require a measured maintenance window; do not modify checksums of applied migrations. Start the canonical telemetry pipeline first, verify its lag and bindings, then start the optional Flink job and explicitly opt in the risk consumer. Keep consumer group IDs stable across restarts. Changing the anomaly group does not reset its durable replay protection.

Initialize offsets for the newly subscribed anomaly topic before opting in. The risk consumer defaults to `RISK_KAFKA_OFFSET_RESET=error`; turning the flag on alone does not initialize missing offsets. While the risk group is stopped, use Kafka's consumer-group reset command scoped to **only** `greenguard.telemetry.anomaly.v1`, first with `--dry-run`, then `--execute` for the reviewed positions. Choose `--to-latest` for prospective enablement (existing advisory records are deliberately skipped), or a reviewed timestamp/earliest position for historical replay. Record the group, every partition, chosen offsets and replay horizon. Preserve existing telemetry/device/lot offsets. Repeat this initialization for any newly added anomaly partitions; never mask missing offsets with a blanket automatic reset. The local live fixture explicitly seeds its fresh test groups at current topic tails.

## Observe

Scrape the risk `/metrics` and `/readyz` endpoints. `risk_configuration_info` reports the actual flag value. Load the optional rules in this directory's deployment alongside Flink job/checkpoint/lag rules. The risk rules match `job,instance` to the enabled target and are silent for a disabled consumer. Compare the exact Kafka consumer groups' committed offsets with log ends; an unavailable group is unknown, not zero lag.

Watch `risk_not_ready_total{reason="threshold_state_unavailable"}`, quarantine and bounded anomaly outcomes. An anomaly waits for its exact triggering telemetry receipt while the telemetry topic continues processing. Repeated context waits need investigation of telemetry lag, device bindings and missing causes. A valid anomaly can wait at least its configured age window; an advancing wall clock expires it as `too_old`. No wall-clock database-retry SLA is established by local tests: PgBouncer backend acquisition can wait beyond an individual retry interval.

Monitor the inbox, rejected telemetry cause ledger, anomaly decision ledger and outbox size and age. Receipts are correctness state, not disposable logs. Purging them can reopen duplicates or strand pending anomalies. No retention purge is approved until a bounded replay horizon, archive/restore procedure and cross-consumer replay tests are established.

## Rollback and recovery

1. Set `RISK_FLINK_ANOMALIES=off` and restart the risk consumer with its existing group. Verify the flag metric is `off`, readiness recovers and threshold assessments still reach notifications.
2. Suspend the optional Flink job or stop only its explicitly owned Compose services. Retain checkpoints, derived topics and database receipts for investigation. Do not delete groups or seek offsets as a rollback shortcut.
3. Leave forward migrations in place. Do not drop receipts or indexes to roll back application behavior. A database rollback needs a separately reviewed restore plan covering Kafka offsets and all downstream consumers.
4. After database failure, restore connectivity, restart failed workers under their original groups and verify queued records commit only after durable database writes. Check assessment/outbox/inbox counts and notification delivery identities before replaying anything.
5. Replay only unchanged canonical event bytes with their required headers. A changed payload under an existing event ID is a conflict and must remain quarantined. Re-enable only after the failed gate has passed again.

The notification provider used by local integration tests is an in-process fixture; delivery rows and successful fixture requests prove integration behavior, not receipt by an external farmer handset or mailbox. Throughput, p95/p99 latency and production outage recovery remain separate qualification gates.
