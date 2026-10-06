# Live re-run 2026-09-25 (Stages 04 to 08)

Logs: `evidence/stage-live-2026-09-25/`. Results are real; nothing was suppressed.

| # | Command | Exit | Key result |
|---|---------|------|-----------|
| 1 | `STAGE07_SKIP_BROKER_PAUSE=1 node scripts/stage07-e2e.mjs` | 0 | trace PASS (07d 4 commands/4 results, compensation trace); GATE race, kill, outage, timeout, redrive, lease PASS; broker SKIPPED by flag |
| 2 | `make history-test` | 0 | TestLiveWriterSurvivesCassandraOutages PASS (long outage 2m10s, offsets 4865..4869); live history tests PASS |
| 3 | `make rabbitmq-test` x3 | 0,0,0 | TestLiveDispatchSurvivesBrokerRestartWithStableIDs PASS 3/3 (earlier 0.32 s failure did not recur; message never captured) |
| 4 | `node scripts/stage06-connect.mjs`, `node scripts/stage06-e2e.mjs` | 0, 0 | two tenants: risk -> CDC -> alert -> CDC -> jobs -> RabbitMQ -> delivery, ack, replay after SIGKILL PASS (risk (tenant_id,id) key works through Debezium) |
| 5 | `make events-e2e` / `events-faults` / `wal-check` | 0 / 0 / 0 | E2E all PASS; E03, E04 PASS; WAL slots reserved |
| 6 | `make search-test`, `projection-replay`, `lot-events-e2e` | 0,0,0 | PASS |
| 7 | `make browser-e2e` | 2 | NOT PASSED: Cassandra container is OOM-killed (exit 137) and cannot restart; gateway history read times out |
| 8 | `make cassandra-test` | not run | needs Cassandra |

## Failures found and fixes (all in script harnesses; no product code changed)
1. Stage 09 revoked INSERT on `tenants` from `inventory_app` (migration 20260925110000). `stage07-e2e.mjs` and `browser-e2e.mjs` now seed the tenant row via `INVENTORY_PROJECTOR_DIRECT_URL`.
2. `.env` has `CONTROL_LOOKUP_TOKEN` but no `CONTROL_PLANE_URL`; telemetry-ingest and notification-service refuse to start. `stage07-e2e.mjs`, `stage06-e2e.mjs`, `events-e2e.mjs` blank both for the child processes.
3. The fixed group `telemetry-binding-consumer` held a large device-topic backlog from earlier suites and stopped fail-closed on `device binding is not available yet`. `stage07-e2e.mjs` now seeds that group to the topic tail.
4. Debezium `risk-outbox` task FAILED ("Couldn't obtain encoding for database greenguard_risk") after the Connect restart; a task restart cleared it (transient).

## Still open
- Cassandra OOM (2 GiB limit, Docker VM 7.7 GB) while `grainguard-quality-sonarqube-1` (1.5 GiB), OpenSearch, MinIO and DynamoDB-local run. SonarQube was expected to be stopped; I did not stop it.
- One earlier `browser-e2e` run also showed `search-indexer` stop on `missing device predecessor` right after a Connect restart; it did not recur. Unproven theory: Debezium replay.
