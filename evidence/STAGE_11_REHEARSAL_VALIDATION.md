# Stage 11 failure-rehearsal validation

Date: 2026-09-26. Worktree `greenguard-stage-11`, branch `codex/stage-11-observability`, uncommitted. Images from `infra/observability/compose.yaml`: `prom/prometheus:v3.2.1`, `prom/alertmanager:v0.28.1`.

## Test-first order for the checker

1. Wrote `scripts/observability-runbook-check.test.mjs` before any implementation: `node --test` failed (module absent), red.
2. Wrote `scripts/observability-yaml.mjs` and `scripts/observability-runbook-check.mjs`: 8 of 9 pass; the one failure was a fixture indentation error in the test, fixed; 9 of 9 green.
3. Real repository run found two heading conventions in use. Added tests for both conventions and the partial-convention message; they failed (import missing), red; then implemented `SECTION_CONVENTIONS`; green.
4. Same order for `scripts/observability-rehearsal.test.mjs` (red: modules absent) then `observability-rehearsal-lib.mjs` and `infra/observability/rehearsal/target.mjs` (green).

## Commands and results

- `node --test scripts/observability-*.test.mjs`: 16 pass, 0 fail.
- `npx prettier --check` on all new files: clean. `npm run lint`: clean.
- `make observability-runbook-check`: unit tests pass; the repository check FAILS with 46 problems across 54 alerts (35 `missing-section` for the missing `Symptom` heading in Kafka/RabbitMQ runbooks, 11 `alert-not-in-runbook` in the existing Codex runbooks). This is a real finding for the owners, not fixed here (the files belong to others).
- `make observability-rehearse` (project `greenguard-obs-rehearsal`, ports 29090/29093/29100/29180, divisor 60, exit 0). Times are scaled seconds: pending, firing, notified since injection; resolved since heal.

| Alert                         | Control                      | Pending | Firing | Notified | Resolved | Result |
| ----------------------------- | ---------------------------- | ------- | ------ | -------- | -------- | ------ |
| ObservabilityTargetDown       | target-down                  | 1.0     | 3.8    | 6.1      | 14.9     | OK     |
| APIHighServerErrorRate        | api-errors                   | 1.0     | 5.9    | 7.9      | 15.1     | OK     |
| ProjectionFreshnessUnknown    | projection-freshness-unknown | 1.0     | 6.1    | 8.1      | 14.8     | OK     |
| CDCCommitLagGrowing           | cdc-commit-lag               | 1.0     | 6.1    | 8.1      | 14.8     | OK     |
| DebeziumConnectorMissing      | debezium-missing             | 1.0     | 6.1    | 8.1      | 15.1     | OK     |
| DebeziumConnectorDisconnected | debezium-disconnected        | 0.8     | 2.8    | 4.8      | 15.1     | OK     |
| DebeziumSourceLagHigh         | debezium-lag                 | 1.0     | 6.1    | 8.1      | 14.8     | OK     |
| ProjectionPendingRecords      | projection-pending           | 1.0     | 11.2   | 13.2     | 14.8     | OK     |
| JobsDispatchLagHigh           | jobs-dispatch-lag            | 1.0     | 6.1    | 8.1      | 14.8     | OK     |
| PostgresClientPoolWaiters     | pool-waiters                 | 1.0     | 3.1    | 5.1      | 15.1     | OK     |
| PostgresPoolExhaustion        | pool-exhaustion              | 1.0     | 3.0    | 5.0      | 14.9     | OK     |
| PostgresSlowQueryRateHigh     | slow-queries                 | 3.1     | 8.1    | 10.1     | 14.8     | OK     |

For each row the harness asserted: pending then firing through the Prometheus HTTP API with firing at least the scaled `for:` after pending; a webhook firing notification whose `severity` equals the rule's and whose `runbook_url` equals the rule's and names an existing file; the alert leaving Prometheus after heal; a `resolved` webhook notification; all alerts clear before the next scenario.

An earlier run (before removing an over-strict check) showed `ProjectionFreshnessUnknown` notifications carry no `job` label, because `absent()` drops labels. This is a real property: that alert cannot name the silent service.

Other defects found while building: Prometheus rejected the synthetic target until it sent `Content-Type: text/plain; version=0.0.4`; a mid-edit typo in `platform.yaml` failed the harness `promtool check rules` (since changed by its owner).

Cleanup: the script ran `docker compose down -v` for its own project only and deleted `infra/observability/rehearsal/.generated/`; `docker ps -a` showed 0 rehearsal containers afterwards. The other 22 running containers were not touched.

## What this does NOT prove (NOT REHEARSED / UNVERIFIED)

- Alerts in `rules/brokers.yaml` (Kafka, Kafka Connect, Schema Registry, replication slots, RabbitMQ, binding feed) and `rules/slo.yaml` (SLO burn, integrity): NOT REHEARSED. They need the real exporters/brokers/database (or additional synthetic controls), planned for the integrated Stage 10d stack. The harness only exercises `platform.yaml`.
- Real failures (broker, Postgres, Debezium, cloud) are UNVERIFIED: the target emits the series named in the expressions; it does not prove the services emit them with those names or labels.
- Timings are scaled by 60 (`for:` and range windows divided; expressions otherwise untouched) with 1s scrape/evaluation; they are not production detection latency. Real scrape (15s) and Alertmanager grouping were not measured. Only the webhook receiver was used: no real paging or notification channel.
- The `for:`-window assertion has 1.5s slack; the same-named `absent()` and `up == 0` alerts can co-fire in production and were rehearsed one at a time.
- Grafana, Loki, Tempo and the OTel collector were not started.

## Follow-up after runbook repairs and Kafka coverage (2026-09-26)

The original checker failure was repaired: `make observability-runbook-check` now passes for all 55 alerts. The five Kafka/Rabbit runbooks have actionable symptom text and retain their detailed diagnosis, mitigation, verification, and escalation steps; the 11 platform alerts are named in their linked runbooks.

The initial harness scales and loads platform and broker rule files, and rehearses two Kafka failure modes in addition to the 12 platform cases. `make observability-rehearse` completed with exit 0 using Prometheus v3.2.1 and Alertmanager v0.28.1; all 14 initial cases delivered correctly labelled firing and resolved webhooks, verified the runbook path, and returned to baseline:

| Alert                         | Control                      | Pending s | Firing s | Notified s | Resolved s | Result |
| ----------------------------- | ---------------------------- | --------: | -------: | ---------: | ---------: | ------ |
| ObservabilityTargetDown       | target-down                  |       0.8 |      3.8 |       14.6 |       15.1 | OK     |
| KafkaBrokerUnavailable        | kafka-brokers-zero           |       1.3 |      3.3 |        5.3 |       15.1 | OK     |
| KafkaExporterTargetDown       | kafka-exporter-down          |       1.0 |      5.8 |       17.9 |       15.1 | OK     |
| APIHighServerErrorRate        | api-errors                   |       1.8 |      6.6 |        8.6 |       15.1 | OK     |
| ProjectionFreshnessUnknown    | projection-freshness-unknown |       1.0 |      5.8 |        7.8 |       15.1 | OK     |
| CDCCommitLagGrowing           | cdc-commit-lag               |       1.0 |      6.1 |        8.1 |       15.0 | OK     |
| DebeziumConnectorMissing      | debezium-missing             |       1.8 |      6.9 |        8.9 |       14.8 | OK     |
| DebeziumConnectorDisconnected | debezium-disconnected        |       2.0 |      4.1 |        6.1 |       15.1 | OK     |
| DebeziumSourceLagHigh         | debezium-lag                 |       1.8 |      6.8 |        8.9 |       15.1 | OK     |
| ProjectionPendingRecords      | projection-pending           |       2.0 |     12.0 |       14.0 |       15.1 | OK     |
| JobsDispatchLagHigh           | jobs-dispatch-lag            |       1.8 |      6.9 |        8.9 |       15.1 | OK     |
| PostgresClientPoolWaiters     | pool-waiters                 |       2.0 |      3.8 |        5.8 |       15.1 | OK     |
| PostgresPoolExhaustion        | pool-exhaustion              |       3.0 |      5.1 |        7.1 |       14.9 | OK     |
| PostgresSlowQueryRateHigh     | slow-queries                 |       4.1 |      9.2 |       11.2 |       14.9 | OK     |

## Integrity SLO follow-up (2026-09-26)

Added the SLO rule file and `IntegrityCDCQuarantined` to the real Prometheus/Alertmanager sink rehearsal. The target increments a synthetic `cdc_quarantined_total` only while the fault is active; recovery waits for the scaled `increase()` window to drain, verifies the resolved webhook, and confirms the harness returns to baseline. That run passed all 15 scenarios; the integrity case fired immediately, notified in 2.5 seconds, and resolved in 15.2 seconds.

## Broker sink follow-up (2026-09-26)

Added synthetic endpoints for RabbitMQ's detailed queue metric and the PostgreSQL slot metric. The full suite passed all 17 scenarios with Prometheus v3.2.1 and Alertmanager v0.28.1:

| Alert                   | Pending (s) | Firing (s) | Notified (s) | Resolved (s) | Result |
| ----------------------- | ----------: | ---------: | -----------: | -----------: | ------ |
| RabbitMQTaskBacklog     |         0.8 |       10.9 |         12.9 |         15.1 | OK     |
| ReplicationSlotInactive |         0.8 |        2.8 |          4.8 |         15.1 | OK     |

The inactive-slot fault also made `ReplicationSlotInactiveCritical` pending; both alerts cleared after recovery. Other broker alerts and SLO burn-rate alert sink paths remain covered by promtool only.

Durations are scaled by 60 and do not represent production detection or notification latency. These are synthetic metric faults; AWS, real contact-point routing, and full trace/log diagnosis are outside this rehearsal.

## Integrated final rehearsal update (2026-09-26)

After integration into the domain-product worktree, `node --test scripts/observability-rehearsal.test.mjs` passed all 7 harness tests and `OBSERVABILITY_DB_PASSWORD=unused node scripts/observability-rehearsal.mjs` completed all 18 scenarios with exit 0. In addition to the 17 scenarios above, `SLOBurnRateFastPage` fired, reached the configured webhook with its expected severity and runbook URL, then resolved after recovery. For this isolated sink rehearsal only, the generated rule copy excludes the slower SLO burn alerts so that the recovery loop remains bounded; checked-in rule files are unchanged. This proves the fast-page alert lifecycle through the local webhook sink, not owner-approved SLO policy, production paging, or the slow/ticket burn alert routes.

The final isolated repository gate, `make -f work/isolation/Makefile verify`, passed on the integrated tree. Its Postgres migrations and live database tests used the isolated PostgreSQL instance at port 55439; the shared development database was not modified. The run also caught and fixed stale module metadata in `services/cdc-transformer`, `services/cache-invalidator`, and `services/cassandra-writer`, plus a projection-builder database test that incorrectly routed dynamically created scratch databases through PgBouncer's static database map. No external AWS or production notification integration was exercised.
