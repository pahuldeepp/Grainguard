# repair_required backlog

Alert: `SagaRepairRequiredBacklog` (`saga_repair_required > 0` for 5 minutes).

## Symptom
A compensation timed out, so the saga was quarantined as `repair_required`. The asset or device may still be held.

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

- Read the saga's audit trail with an admin token: `GET /v1/provisioning/{saga_id}` (tenant-scoped; cross-tenant IDs return 404).
- Check the participant receipts for the compensation command: hardware `hardware_command_receipts`, inventory `inventory_saga_receipts`, under that tenant's RLS context.
- A late result is reconciled automatically (`late_result.reconciled` audit rows); confirm one has not already arrived.

## Mitigation
1. Fix the participant (see participant-down runbook).
2. Redrive with an admin token: `POST /v1/provisioning/{saga_id}/redrive`. The redrive is audited and re-queues the compensation with the same fence.
3. Never edit `provisioning_sagas.state` directly.

## Escalation
Escalate to the Stage 07 owner when a redriven saga returns to `repair_required`, or more than 20 are open.
