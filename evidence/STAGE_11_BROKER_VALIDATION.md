# Stage 11 broker monitoring validation

Date: 2026-09-26. Worktree branch `codex/stage-11-observability`. Nothing committed.

## What was added (all new files unless noted)

- `infra/observability/rules/brokers.yaml`: 3 recording rules, 35 alerts (Kafka, Connect/Registry, replication slots, RabbitMQ, binding feed).
- `infra/observability/tests/brokers.test.yaml`: 72 promtool cases, two per alert (pending before `for:` then fires with exact labels/annotations; silent when healthy), plus extra +Inf/300s/200s cases for `BindingFeedAgeCritical`. Generated from a compact spec kept outside the repo; annotations were copied from the rules, so runbook URLs are checked separately below.
- `infra/observability/grafana/dashboards/brokers.json` (uid `greenguard-brokers`, 16 panels).
- `infra/observability/prometheus-brokers.yaml`: scrape fragment (3 jobs) with merge instructions.
- `infra/observability/exporters/streaming-state-exporter.mjs` + `.test.mjs`: dependency-free Node exporter for Connect connector/task state and Schema Registry reachability.
- `infra/observability/postgres-exporter-slots.yaml`: custom queries for retained WAL, mirroring `scripts/wal-check.mjs`.
- Runbooks: `docs/runbooks/kafka-consumer-lag.md`, `kafka-connect-failed.md`, `kafka-replication-slot.md`, `rabbitmq-dlq-growth.md`, `rabbitmq-queue-backlog.md`.
- Additive edits to shared files: `infra/observability/compose.yaml` (two services under profile `brokers`), `Makefile` (`observability-test-broker-rules`), `infra/observability/README.md`, `docs/runbooks/README.md`.

## Exporter choice

Kafka: `danielqsj/kafka-exporter` v1.9.0 (already in `infra/kafka/compose.yaml`, digest `sha256:4150e46b...`). Metric names below were read from its live `/metrics` HELP output, not from memory: `kafka_brokers`, `kafka_consumergroup_lag_sum`, `kafka_consumergroup_current_offset_sum`, `kafka_consumergroup_members`, `kafka_topic_partition_leader`, `kafka_topic_partition_under_replicated_partition`, `kafka_topic_partition_current_offset`, `kafka_topic_partition_oldest_offset`. The exporter has no byte size or offline-partition metric, so offline = `leader < 0` and topic growth = retained record count.
RabbitMQ: built-in `rabbitmq_prometheus` (4.2.9). Names read from live `/metrics` and `/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count&vhost=/`.
Connect/Registry: Connect exposes no Prometheus endpoint without JMX, so a small REST-polling exporter was written (image `node:24.21-alpine`, index digest `sha256:ebfe2f90...` resolved with `docker buildx imagetools inspect`).
Slots: `postgres_exporter` v0.15.0 (digest already used in compose) with `--extend.query-path`; its built-in slot collector lacks `restart_lsn`.

## Order (red then green)

1. Wrote the test spec first. Generation failed with ENOENT because `rules/brokers.yaml` did not exist (red).
2. Wrote the rules; first `promtool test rules` run failed on 8 cases (expected job labels, and a too-early pending time on `KafkaConsumerGroupStalled`); fixed the spec, not the rules' intent.
3. Exporter: wrote `streaming-state-exporter.test.mjs` first; `node --test` failed with `ERR_MODULE_NOT_FOUND`; then implemented; 5/5 pass.

## Commands run and results

- `promtool check rules rules/brokers.yaml` (prom/prometheus:v3.2.1 via docker): `SUCCESS: 38 rules found`.
- `promtool test rules tests/brokers.test.yaml`: `SUCCESS` (72 cases).
- Mutation check on a temp copy: changing `for: 5m` to `for: 1m` and `pg_wal_slot_active == 0` to `== 1` each made promtool report FAILED cases, so the tests are not vacuous.
- `promtool check config` on a temp merge of `prometheus.yaml` plus `prometheus-brokers.yaml`: valid; `promtool check rules` on brokers.yaml + platform.yaml: SUCCESS. No duplicate alert names across `rules/*.yaml`.
- `make observability-test-broker-rules`: check, test and 5/5 node tests pass.
- `node scripts/observability-validate.mjs`: `observability config validation passed: 5 dashboards, bounded-label audit, rules, and runbooks`. Extra grep for tenant/device/request/event/trace/span ids in my files: none.
- All 5 `runbook_url` targets exist as files. `prettier --check` on every file I own: clean. Dashboard JSON parses. `docker compose --profile brokers config -q`: valid.
- Live, read-only against the running dev stack, with temporary containers that were removed afterwards (`docker stats` first: Kafka 2.2 GB, total well under the 7.7 GB limit): kafka-exporter (pinned digest, 64 MB) scraped Kafka and returned all names above; `streaming-state-exporter` (64 MB) returned `greenguard_connect_up 1`, `greenguard_schema_registry_up 1` and RUNNING state for all 8 connectors; the RabbitMQ metric queries returned per-queue series for `notifications.{tasks,retry,dlq,receipts}` and node memory/disk gauges. The slot query was run through `psql` as `postgres` and returned all 8 logical slots.

## Findings from the live dev stack

- The dev Kafka holds hundreds of ephemeral consumer groups (`browser-e2e-cdc-*`, `stage06-*`, `cassandra-outage-*`, ...). Alerting per group would be noise and a cardinality risk, so lag alerts use an explicit durable-group allowlist in `rules/brokers.yaml`; new long-lived consumers must be added to it. Consider `--group.filter` on the exporter.
- Slot `greenguard_control_outbox` is inactive and retains about 296 MB (about 14 percent of the 2 GB cap); `greenguard_read_notifications` retains about 319 MB. `ReplicationSlotInactive` would fire on this today.
- RabbitMQ metrics port 15692 is published only by the `infra/rabbitmq` overlay, not by the running dev container.

## UNVERIFIED

- `postgres-exporter-slots` running end to end: the `greenguard_observer` role does not exist in the running dev database, so only the SQL was verified, not the exporter's custom-query parsing or the resulting `pg_wal_slot_*` names.
- Full Prometheus scrape of the new jobs and the alerts firing on live data; Grafana rendering of `brokers.json`; alert delivery through Alertmanager. Prometheus and Grafana were not started.
- `kafka_topic_partition_leader` reporting -1 for an offline partition (exporter behaviour assumed from Kafka semantics; not induced).
- Connect `restart?includeTasks=true&onlyFailed=true` and `resume` calls in the runbook (standard Connect REST API, not executed to avoid disturbing running connectors); `du` path in the Kafka container; DLQ replay commands were not run.
- Debezium snapshot state and streaming lag (need JMX); expected-slot-missing and expected-connector-missing alerts (not implemented).
- Alert thresholds marked "candidate" (lag 1000, retained 10M records, task backlog 1000, unacked 500, retry 100) are unmeasured; broker count threshold assumes the single local broker.
- Alert `for:` behaviour is proven only against synthetic series with 1 minute resolution.

## Follow-up runtime verification (2026-09-26)

The broker alert count is now 36 (39 broker rules including three recording rules); `KafkaExporterTargetDown` distinguishes missing/down telemetry from a healthy exporter reporting zero brokers. The live profile previously exposed that false-positive edge; its rule and synthetic cases now pass.

- Prometheus loaded the platform, broker, and SLO rule groups. Its live `kafka-exporter` and `kafka-connect-state` targets were `up`.
- A temporary, pinned Kafka exporter joined the already-running dev Kafka network read-only. It reported one broker and real consumer-group lag. Durable-group allowlists kept ephemeral browser test groups out of alert selection. The live sample produced pending lag/stalled/no-member alerts for configured durable groups; `KafkaBrokerUnavailable` was not active.
- The profile's streaming-state exporter queried the running Connect and Schema Registry endpoints. Prometheus observed 8 connectors in `RUNNING` state; `greenguard_connect_up` and `greenguard_schema_registry_up` were 1.
- RabbitMQ's Prometheus plugin is enabled. A read-only request from its Docker network returned HTTP 200 and 16 queue metric series for `notifications.{retry,tasks,dlq,receipts}`. The existing dev container does not publish 15692 to the host, so the configured host scrape target remains down; the project overlay publishes that port for a fresh integrated stack.
- Read-only SQL against the live dev database showed 8/8 logical slots active. `greenguard_control_outbox` was active with about 219 MB retained at the sample time. The `greenguard_observer` role is absent in that already-running database, so the custom slot exporter still cannot authenticate or prove emitted series. The repository's initialization SQL grants `pg_monitor` to that role on a newly initialized database; the existing database was not changed.
- The live Grafana API listed all five provisioned dashboards. The broker dashboard is provisioned, but panels requiring Rabbit host scrape or slot-exporter series do not have live Prometheus data in this environment.

Still unverified: connector restart/resume runbook calls; induced broker/Connect/Rabbit/slot faults against real dependencies; page delivery to a real contact point; AWS metrics; and full Stage 10d journey correlation. The live local profile is diagnostic evidence, not a production readiness claim.

## Shared-database heartbeat regression guard and slot progress (2026-09-26)

- `scripts/kafka-connect.mjs` validates all checked-in connector JSON configs before applying its connectors. The validation groups configs by `database.dbname`; if any connector in a database emits heartbeats, each sibling must declare `message.prefix.exclude.list`. `scripts/events-lib.test.mjs` covers the missing-filter failure and validates the checked-in configs (3/3 tests pass).
- The three checked-in non-heartbeat outbox configs exclude logical messages with `message.prefix.exclude.list=.*`. The inventory heartbeat connector continues to include only `greenguard.binding-feed` messages.
- Read-only inspection of the dev Connect REST API showed the live `notification-contacts` heartbeat connector shares `greenguard_control` with `control-outbox`; the live control connector has the exclusion configured, and all eight connector tasks reported RUNNING.
- Three read-only replication-slot samples showed `greenguard_inventory_outbox` and `greenguard_control_notification_contacts` advancing. `greenguard_control_outbox` stayed at `confirmed_flush_lsn=1/5B07C1D8` while remaining active, approximately 219 MB behind current WAL. Quiet control-outbox progress is therefore **not confirmed** and remains an investigation item; we did not change slots or offsets.
- Connect's access logs cannot establish the caller-side timeout. The closest config call was `PUT /connectors/control-outbox/config`, which returned HTTP 201 after 4,418 ms; the restart POST returned HTTP 202 after 37 ms. The client now names method/path and timeout duration in future timeout exceptions, without logging request bodies.
- The running dev Connect container has no JMX configuration and publishes only REST port 8083. A temporary read-only exporter connection to `connect:9404` was refused, so Debezium source-event and filtered-message metrics are unavailable for this slot investigation. The separate fresh-stack Compose JMX path has not yet been validated against the live Connect image.

The earlier conclusion above that quiet control-outbox progress was unconfirmed is superseded by [the post-fix heartbeat validation](STAGE_11_CONTROL_OUTBOX_PROGRESS.md): the targeted heartbeat config was applied and both the source offset and slot LSN advanced on two consecutive samples.
