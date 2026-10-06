# Saga stuck past its deadline

Alert: `SagaStuck` (`saga_deadline_overdue > 0` for 2 minutes).

## Symptom
Sagas in `reserving`, `configuring`, `activating` or `compensating` are past `deadline_at` and the worker is not expiring them. Users see provisioning stay pending.

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

- `saga_deadlines_expired_total` not increasing while overdue is non-zero: the deadline scan is not running. Check the worker log for `saga shard lease lost` or a fatal error.
- Check that every shard is leased: `SELECT count(*) FILTER (WHERE expires_at > now()) FROM saga_shard_leases` must be 64 (or `SAGA_MAX_SHARDS` times the number of workers).
- A tenant missing from `saga_dispatch_tenants` is never scanned: `SELECT count(*) FROM provisioning_sagas s WHERE NOT EXISTS (SELECT 1 FROM saga_dispatch_tenants d WHERE d.tenant_id=s.tenant_id)`.

## Mitigation
1. Start another saga worker (`make saga-worker` or scale the deployment); leases rebalance within one TTL.
2. If a worker is wedged, kill that worker process only; its leases expire after `SAGA_LEASE_TTL_SECONDS` and the fencing token blocks it from committing afterwards.
3. Backfill a missing dispatch row through the saga API start path, never by hand-editing state.

## Escalation
Page the Stage 07 owner if overdue sagas persist for 15 minutes after a healthy worker holds all shards.
