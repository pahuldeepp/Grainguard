# Local CDC and recovery acceptance — 2026-10-10

Source revision: `cf7f097` (`Clean up fault-test outbox fixtures safely`).

Both commands completed with exit code 0 against the isolated Compose project
`greenguard-goal-local-20261010`; their stdout is preserved in the adjacent log
files. The project used its dedicated PostgreSQL database volume, one local Kafka
broker (RF1), Schema Registry and Debezium Connect. No other Compose project was
used by these runs.

## Results

- `make COMPOSE_PROJECT_NAME=greenguard-goal-local-20261010 events-e2e`: outbox →
  raw topic → CDC transformer → canonical topic → binding; poison quarantine;
  SIGKILL/replay with exactly one effect; six source checkpoints; stale-feed 503
  and recovery.
- `make COMPOSE_PROJECT_NAME=greenguard-goal-local-20261010 events-faults`: E03
  crash after broker acknowledgement and before source offset commit; E04
  quarantine publish failure and recovery with no premature offset advance; E05
  idle singleton delivery within 15 seconds and pending-record survival across
  restart. The harness also verifies that the current transport remains
  singleton/no-batch.

## Limits

This is local event/CDC fault acceptance, not a full GreenGuard product-path test.
It does not exercise the projection-builder read model, Cassandra, alerts, web or
iPhone flows. Kafka used one broker at RF1. It does not measure ingestion
throughput or establish the 20K/s sustained, 50K/s peak, p95 freshness, API latency,
availability, or zero-loss production objectives. The throughput targets remain
unmeasured; no batching optimization is certified by this evidence.
