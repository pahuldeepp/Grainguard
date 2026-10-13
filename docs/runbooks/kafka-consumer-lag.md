# Runbook: Kafka consumer lag, stalled group, broker health, binding feed

**Owner:** platform on-call (streaming).  
**Severity:** page for `KafkaBrokerUnavailable`, `KafkaOfflinePartitions`, `KafkaConsumerGroupStalled`, `KafkaConsumerGroupNoMembers`, `BindingFeedAgeCritical`; ticket for `KafkaExporterTargetDown`, `KafkaUnderReplicatedPartitions`, `KafkaConsumerGroupLagHigh`, `KafkaTopicRetainedMessagesHigh`, `BindingFeedAgeWarning`, `BindingConsumerQuarantine`, `BindingFeedClockSkew`, `CDCQuarantinedRecords`.  
**Signals:** `kafka_consumergroup_lag_sum`, `kafka_consumergroup_current_offset_sum`, `kafka_consumergroup_members`, `kafka_brokers`, `kafka_topic_partition_*` (kafka-exporter), `binding_feed_age_seconds`, `binding_consumer_quarantine_total`, `cdc_commit_lag`. Dashboard: _GreenGuard - Kafka, Connect and RabbitMQ_.

Lag alerts cover only the durable consumer groups named in `infra/observability/rules/brokers.yaml`. Add each new long-lived consumer group to that allowlist. Ephemeral groups created by tests are deliberately ignored.

## Symptom

KafkaExporterTargetDown means broker metrics are unknown. KafkaBrokerUnavailable requires a healthy exporter reporting zero brokers. Group-lag/stall alerts identify durable groups; inspect their group and topic labels before taking action.

## Diagnosis

Shorthand: `EV="docker compose --env-file .env -f infra/compose/compose.yaml -f infra/kafka/compose.yaml"`.

1. Is the broker up? `$EV ps kafka` and `$EV logs --tail=100 kafka`. Offline or under-replicated partitions:
   `$EV exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:29092 --describe --unavailable-partitions`
   and `--under-replicated-partitions`.
2. Which group and partitions are behind, and are there members?
   `$EV exec -T kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:29092 --describe --group <group>`
   Note `LAG`, `CONSUMER-ID` (empty means no member), and partition skew.
3. If the group has no member, the service is down: check its `up` series, its logs, and `make` target that starts it. If members exist but the offset does not move, look for a crash loop, fenced transaction, a blocked downstream dependency (Postgres pool saturation, see [database saturation](database-saturation.md)), or a poison record that is retrying without quarantine.
4. CDC path: `cdc_commit_lag` above zero for long means the transformer fetched records it cannot commit. Check `cdc_quarantined_total{reason}`; every quarantined record needs a disposition.
5. Binding feed (ADR-0009, R7): `curl -fsS http://127.0.0.1:8080/metrics | grep binding_`. Ingest returns `503 binding_feed_stale` at 300 s. Check Connect ([kafka-connect-failed](kafka-connect-failed.md)), the transformer, `telemetry-binding-consumer` lag, and source/ingest clock skew. Quarantine reasons: `heartbeat` (malformed) or `db_rejected` (SQLSTATE 22/23).
6. Retained records high: offsets are records, not bytes. Check disk use with `$EV exec -T kafka du -sh /var/lib/kafka/data` and retention (`KAFKA_LOG_RETENTION_HOURS`, 168 h locally).

## Mitigation

- Restore the failed consumer or dependency first. Lag drains on its own; scale only within the partition count and downstream capacity.
- Restart a stuck consumer process; do not delete the group.
- **Never** reset offsets, delete topics or clear inboxes to make an alert go away. If the failure names a committed offset outside retention (B1), follow the raw-topic retention section of [WAL retention and CDC recovery](../WAL_RETENTION.md): preserve offsets, replay retained outbox rows with original event IDs, reconcile.
- Recreated raw topic or empty checkpoints: use `make binding-feed-reset ARGS=--yes` only after the recovery plan in [WAL retention](../WAL_RETENTION.md) is ready and admission is stopped.
- Broker down: restart with `$EV up -d --wait kafka`; wait for the health check, then confirm consumers rejoin.

## Verify

Lag falls and `kafka_consumergroup_current_offset_sum` rises for the group; `binding_feed_age_seconds` returns below 60; alerts resolve; accepted event IDs reconcile. Save sanitized before/after evidence.

## Escalation

Page the streaming owner if a partition stays offline for 10 minutes, if a group is stalled with members present, or if any raw-topic offset is outside retention.
