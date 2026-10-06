# Compensation backlog

Alert: `SagaCompensationBacklog` (`saga_compensation_backlog > 20` for 10 minutes).

## Symptom
Many sagas are `compensating`: release or deactivate commands are queued or unanswered.

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

- `saga_commands_pending` high: commands are not being published (worker or Kafka problem).
- Pending low but backlog high: participants are not answering `asset.release` or `inventory.deactivate`. Check the hardware and inventory worker logs and their consumer-group lag:
  `docker exec greenguard-kafka-1 /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group greenguard.hardware.v1`
- Check the command DLQ `greenguard.saga.commands.dlq.v1` for quarantined commands.

## Mitigation
1. Restore the participant; its receipts make redelivery safe.
2. Compensations that exceed their deadline become `repair_required` automatically; handle them with the repair runbook.

## Escalation
Page the Stage 07 owner if the backlog grows for 30 minutes with healthy participants.
