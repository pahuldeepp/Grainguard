# Runbook: Kafka Connect, Debezium connector or Schema Registry down

**Owner:** platform on-call (streaming).  
**Severity:** page for `KafkaConnectUnreachable`, `KafkaConnectConnectorFailed`, `KafkaConnectTaskFailed`, `SchemaRegistryDown`; ticket for `KafkaConnectConnectorPaused`.  
**Signals:** `greenguard_connect_up`, `greenguard_connect_connector_state`, `greenguard_connect_task_state`, `greenguard_schema_registry_up` (streaming-state exporter), plus [replication slot](kafka-replication-slot.md) signals. While a connector is not RUNNING, committed outbox rows are not captured and WAL accumulates behind its slot.

Debezium snapshot and streaming JMX metrics are not exported yet; use the REST status below for snapshot progress.

## Symptom

The Connect state exporter reports an unreachable API, FAILED/PAUSED connector, or failed task; Schema Registry may also be unreachable. Confirm connector/task labels before restart.

## Diagnosis

Shorthand: `EV="docker compose --env-file .env -f infra/compose/compose.yaml -f infra/kafka/compose.yaml"`.

1. Connect reachable? `curl -fsS http://127.0.0.1:58083/connectors?expand=status`.
2. One connector: `curl -fsS http://127.0.0.1:58083/connectors/<name>/status`. The `trace` field of a FAILED task holds the exception. Connector names are `<database>-outbox` (`inventory`, `telemetry`, `risk`, `alerts`, `billing`, `control`) plus `notification-contacts` and `projection-notifications`.
3. Logs: `$EV logs --tail=200 connect`.
4. Common causes: PostgreSQL unreachable or restarted, replication slot missing or invalidated (`make wal-check`), missing publication or privileges, Schema Registry or Kafka unavailable, `CDC_DB_PASSWORD` unset.
5. Schema Registry: `curl -fsS http://127.0.0.1:58081/subjects`, `$EV logs --tail=100 schema-registry`.

## Mitigation

- Transient failure: restart only the failed pieces, `curl -fsS -X POST 'http://127.0.0.1:58083/connectors/<name>/restart?includeTasks=true&onlyFailed=true'`.
- Paused: `curl -fsS -X PUT http://127.0.0.1:58083/connectors/<name>/resume` after confirming why it was paused.
- Connect or Registry process down: `$EV up -d --wait schema-registry connect`, then `node scripts/kafka-connect.mjs` re-applies every connector config idempotently and waits for RUNNING.
- If the failure log or `make wal-check` shows a lost or unreserved slot, restarting cannot recover removed WAL: follow [WAL retention and CDC recovery](../WAL_RETENTION.md) (fresh slot and connector identity, outbox replay with original event IDs). Do not delete a healthy connector as a generic repair.
- Keep admission decisions with the binding feed rules: when the feed goes stale, ingest fails closed by design.

## Verify

`greenguard_connect_connector_state{state="RUNNING"}` is 1 for every connector, no FAILED tasks, `make wal-check` exits 0, `binding_feed_age_seconds` falls, and `make events-test` passes on a dev stack. Alerts resolve.

## Escalation

Escalate to the CDC owner when a slot is unreserved or lost, or a connector fails again within 15 minutes of restart.
