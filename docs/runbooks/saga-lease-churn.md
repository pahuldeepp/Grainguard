# Lease churn

Alert: `SagaLeaseChurn` (more than 3 lost leases in 10 minutes).

## Symptom
Workers lose shard leases and refuse side effects (`lease lost; side effect refused` in logs). Throughput drops; there are no duplicate effects because fencing refuses the stale holder.

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

- `SELECT holder, count(*), max(fencing_token) FROM saga_shard_leases GROUP BY holder`: tokens rising fast mean repeated takeover.
- Check worker CPU pauses, GC, or database latency: a renewal must finish inside `SAGA_LEASE_TTL_SECONDS / 3`.
- Check the clock on workers and the database; leases use database time (`now()`), so worker clock skew alone is not the cause.

## Mitigation
1. Raise `SAGA_LEASE_TTL_SECONDS` (2..300) and roll the workers.
2. Reduce `SAGA_MAX_SHARDS` per worker so each worker renews fewer rows.
3. Relieve database pressure (PgBouncer pool, slow queries) before adding workers.

## Escalation
Escalate to the platform on-call if database latency is the cause, otherwise to the Stage 07 owner.
