# Whole-tree gate, 2026-09-24

Run by the coordinating session on the uncommitted working tree (HEAD `48202e7`, about 315 changed files) after the shared Go transport refactor, the Stage 05 slices and Stage 06a-06d were built by separate agents. Every line below is a command that was run and its real outcome. Nothing here is CI evidence: no push has happened and none of the new live jobs have run remotely.

## Static and unit gates

| Command | Result |
| --- | --- |
| `make verify` | exit 0 (run twice, before and after the shared-code refactor settled) |
| `make coverage` | exit 0 |
| SonarQube scan (`-Dsonar.scm.disabled=true`, see caveat) | quality gate PASSED: coverage 89.5% (new 89.5%), duplicated lines 0.0%, violations 0, all six conditions OK |
| `make risk-test` | 68 tests OK, including live PostgreSQL tests |
| workflow-alerts tests | 44 of 44 pass against live PostgreSQL |
| `packages/contracts` tests | 17 of 17 pass |

Caveat: the default scan hangs in the scanner's Git blame step under emulation, so the scan was run with SCM attribution disabled. CI runs the default scan, so its "new code" conditions may differ. This result is a local check, not the final gate.

## Live tests (Kafka, Connect, Schema Registry, PostgreSQL, PgBouncer, RabbitMQ, Cassandra, Elasticsearch running locally)

| Command | Result |
| --- | --- |
| `make events-up` | exit 0; inventory and telemetry connectors RUNNING (risk and alerts connectors not registered) |
| `make events-test` | PASS: raw CDC E01, R1 snapshot, E02 Connect outage |
| `make events-e2e` | 6 of 6 PASS: outbox to binding, poison quarantine, SIGKILL and replay once-in-effect, heartbeat checkpoints, stale-feed 503 and recovery |
| `make events-faults` | PASS E03; PASS E04 quarantine-publish failure (retries, degraded readiness, no offset advance); PASS E04 healthy quarantine; PASS E05 |
| `make wal-check` | exit 0; both slots `reserved`, retained bytes far below the 2 GB cap |
| `make cassandra-test` | PASS live history replay, tenant isolation, TTL expiry (two Kafka tests skip by design) |
| `make history-test` | PASS `TestLiveCassandraNodeOutageCatchUp` and `TestLiveKafkaCassandraCrashReplay` |
| `make search-test` | PASS live index, replay idempotence, tenant isolation, alias swap, Kafka facility event indexed |
| `make projection-replay` | PASS versioned replay, `TestLiveVersionedReplay`, `TestLiveDatabaseReplayResume` |
| `make lot-events-e2e` | PASS placement, inventory outbox, Debezium, transformer, dedicated lot topic, versions 1 and 2 |
| `make rabbitmq-test` | PASS broker restart mid-dispatch, delivery-limit dead-lettering, DLQ replay with stable id |

## Image builds

`docker build` succeeds for device-service, telemetry-ingest, cdc-transformer and projection-builder. cassandra-writer and jobs-worker have no Dockerfile.

## Not verified

- No remote CI run of any of the above, including the new live jobs.
- Risk and alerts outbox CDC (connectors, transformer routing, topics) is not registered or exercised.
- jobs-worker consumes a local alert fixture, not the real alert contract from Kafka.
- Risk Engine, alert service and notification-service Kafka paths are tested against fakes only.
- No full score, alert, delivery and acknowledgement end-to-end test yet.
- Docker builds for risk-engine, workflow-alerts, notification-service and search-indexer were not run.
- Independent tenant-isolation and architecture reviews of Stages 05 and 06 have not been run.
