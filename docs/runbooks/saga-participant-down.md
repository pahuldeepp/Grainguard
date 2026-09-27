# Participant or worker down

Alert: `SagaParticipantDown`.

## Symptom
Commands wait unpublished (`saga_commands_oldest_pending_seconds > 120`) or a participant process is down: the saga worker, `hardware-service`, the inventory saga worker (`services/device-service` `saga:worker`) or the telemetry binding worker (`SAGA_BINDING_ENABLED=1`).

## Diagnosis
Common checks (run from the repository root after `set -a; . ./.env; set +a`):

```bash
curl -s "$SAGA_METRICS_URL/metrics" | grep ^saga_          # worker gauges and counters
docker compose -p greenguard-dev ps                          # shared containers (never pause or restart them from a runbook)
```

Database checks use the owner role and the count-only functions, which return no tenant data:

```bash
docker exec -e PGPASSWORD=$SAGA_MIGRATOR_PASSWORD greenguard-dev-postgres-1 \
  psql -h 127.0.0.1 -U saga_migrator greenguard_sagas -c "SELECT * FROM saga_state_metrics()"
```

- Process health: the worker exits non-zero on a fatal error; check its supervisor and last log lines.
- Participants discover tenants themselves through ID-only selectors (`inventory_saga_result_tenants`, `saga_binding_result_tenants`, `hardware_unpublished_result_ids`). A worker started with the retired `INVENTORY_SAGA_TENANT_IDS` or `SAGA_BINDING_TENANT_IDS` refuses to start: remove the variable.
- Kafka: consumer-group lag for `greenguard-inventory-saga-v1`, `telemetry-saga-binding-v1`, `greenguard.hardware.v1`.

## Mitigation
1. Restart only the failed process. Command receipts and result outboxes make replay safe; the result ID never changes.
2. If Kafka is unavailable, wait: nothing is lost because commands and results stay in their outboxes.

## Retry and DLQ bounds
- Saga commands: at-least-once from the outbox, one row per tick per tenant, at most 50 per tenant per pass; no retry cap, because the saga deadline bounds the wait and then compensates.
- Participants: malformed or conflicting commands go to `greenguard.saga.commands.dlq.v1` before the offset commits; transient database errors stop the worker without committing (telemetry retries registration 5 times, 1 s apart, then stops).
- Saga results: permanent errors go to `greenguard.saga.results.dlq.v1` once, and the offset commits only after the DLQ acknowledgement.

## Escalation
Page the owning service's on-call; escalate to the Stage 07 owner if replay after restart does not drain the backlog.
