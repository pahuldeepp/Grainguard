# Stage 11 local observability profile validation

Date: 2026-09-26 UTC  
Branch: `codex/stage-11-observability`  
Base: `176f449` (`Advance saga after idempotent reserve results`), a committed repository state predating the uncommitted Stage 10d work in the shared checkout.

## Passed

- `docker compose --env-file .env.example -f infra/observability/compose.yaml config --quiet`
- `docker compose ... up -d`; Prometheus, Grafana, Alertmanager, Loki, Tempo, OpenTelemetry Collector, node exporter, and Postgres exporter reached running state. Tempo/Loki return readiness after a short startup grace period.
- Prometheus `/-/ready` returned `Prometheus Server is Ready.`
- Grafana `/api/health` returned database `ok`, version `11.5.2`.
- Grafana API listed the three provisioned dashboards: `greenguard-platform-overview`, `greenguard-service-health`, `greenguard-slo`; data sources Loki, Prometheus, Tempo were provisioned.
- Prometheus `promtool check config` passed with exactly the production rule file loaded, and `promtool check rules` found 20 valid rules. Synthetic rule tests live outside the production rules glob.
- `node scripts/observability-validate.mjs` passed: three dashboard JSON documents, forbidden identifier label audit, required alert and runbook presence.
- `make observability-test-rules` passed: synthetic sustained API 5xx, PostgreSQL pool waiters, Go pool exhaustion, and slow-query rate each fired with expected labels and runbook annotations.
- OTLP/HTTP metric POST returned 200; Prometheus query returned `greenguard_otel_stage11_smoke_counter_total` from the Collector scrape.
- OTLP/HTTP trace POST returned 200; Tempo search found the synthetic service trace, and `/api/traces/<trace-id>` returned one span. Grafana's Tempo datasource was checked for trace-to-logs, trace-to-metrics, node graph, and search configuration.
- Grafana API listed all three provisioned dashboards after appending Basic auth; unauthenticated API requests correctly returned 401.
- The Go common package RED tests pass normally and with `-race`; telemetry-ingest and jobs-worker Go package suites pass.
- Device-service and workflow-alerts TypeScript typechecks pass; `npm run format:check` passes.
- `@greenguard/otel` tests pass for fixed pool saturation gauges and bounded PostgreSQL query-duration buckets; device-service and workflow-alerts enable Prisma query events while discarding SQL and parameter payloads. Notification-service exposes bounded pg pool gauges.
- `packages/go-common`, telemetry-ingest, projection-builder, and jobs-worker Go package suites pass with pgx pool metrics integrated; `packages/go-common` also passes under `-race`. Telemetry-ingest `/metrics` remains available in health-only mode. pgx pool metrics expose configured/total/idle/acquired connections, acquire counts, cancellations, and cumulative waits with fixed service labels.
- Alertmanager API accepted a synthetic alert; the configured webhook test receiver observed both `firing` and `resolved` payloads.
- Observability, base infrastructure, Kafka overlay, and Rabbit overlay Compose configurations validate when overlays are combined with the base file.
- Added a pinned JMX exporter for Kafka Connect / Debezium: the Debezium Connect image entrypoint was inspected for `JMXPORT` / `JMXHOST` support, the exporter image digest and standalone CLI were verified locally, its configuration starts the exporter, the combined base + Kafka Compose overlay validates, and Prometheus is configured to scrape it. Panels and alerts now include Connect worker/task metrics plus Debezium PostgreSQL capture connectivity, internal queue headroom, event throughput, and source lag. This is configuration evidence only: no Connect/Debezium runtime was started in this worktree, so live connector metrics and alert behavior remain unverified.
- Added a pinned, opt-in CloudWatch exporter profile with allowlisted Lambda functions / DynamoDB tables, real AWS/Lambda and DynamoDB metric names, optional Lambda Insights init-duration series, Prometheus scraping, and dashboard queries offset to account for the exporter’s ten-minute convergence delay. The image digest was pulled locally and the exporter started with the config (no credentials are provided, so no AWS API request or live metric series was verified). AWS profile Compose config and Prometheus syntax validate. Cost/permissions and the account’s enabled Lambda Insights remain to be validated in an authorized AWS account.
- Current Prometheus targets show `prometheus`, `node-exporter`, and `otel-metrics` up; app targets are down because the app processes were deliberately not started in this isolated profile. Current scrape coverage includes telemetry-ingest, CDC transformer, projection builder, jobs-worker, device-service, workflow-alerts, notification-service, and risk-engine. Postgres/Rabbit/Kafka exporter targets are down or unverified because the Stage 10d shared dependencies must not be restarted or mutated.
- The Postgres exporter `/metrics` endpoint responds HTTP 200, but it has not been shown to authenticate to the Stage 10d Postgres service.

## Not proven in this gate

The test was a backend pipeline smoke, not a GreenGuard production journey. Go RED instrumentation is shared by telemetry-ingest, CDC, projection builder, and jobs worker; Nest RED middleware is present in device-service and workflow-alerts. Instrumented Prisma pools expose client saturation and query duration for device-service and workflow-alerts; notification-service exposes pool saturation. Process/container USE, exporter runtime against active dependencies, full user-flow trace/log correlation, end-to-end notification delivery metrics, AWS throttles/cold starts, alert-rule-triggered webhook delivery, and incident/runbook rehearsal were not demonstrated. The webhook test injected a synthetic alert directly into Alertmanager and only proves routing/delivery. Those remain Stage 11 exit requirements after Stage 10d is gated and integrated. Proposed SLO targets remain unapproved.

One earlier OTLP smoke counter was cumulative; after restarting the collector it was no longer present, so the metric-path test should be rerun during the next full profile rehearsal. No production claim should be inferred from this local profile.

## Follow-up runtime verification (2026-09-26)

A fresh isolated profile was started without the Postgres exporter because the current worktree has no `.env` and the running dev database lacks `greenguard_observer`:

```sh
docker compose --env-file .env.example -p greenguard-stage11-observability \
  -f infra/observability/compose.yaml up -d \
  prometheus grafana alertmanager loki tempo otel-collector node-exporter
```

Prometheus, Alertmanager, Grafana, Loki, Tempo, and Collector readiness returned HTTP 200 after startup grace. Grafana's authenticated API listed five dashboards. Prometheus loaded four alert groups (12 platform, 36 broker, 7 SLO alert rules) and scraped Prometheus, node-exporter, OTel metrics, Kafka exporter, and Connect state exporter successfully. The two app groups tested in this run remained unavailable because service processes were not started; Rabbit host metrics, slot exporter, AWS, and Connect JMX were also unavailable through the configured host targets.

A short OTLP smoke sent one metric and one trace to the Collector. The metric `greenguard_otel_stage11_smoke_value` appeared in Prometheus with value 7, and Tempo returned the `stage11-smoke-span` trace by ID. This demonstrates the backend path only, not correlation from a GreenGuard request or logs in Loki.

For read-only dev dependency checks, a temporary pinned Kafka exporter on the existing dev Docker network returned `kafka_brokers 1`; the Compose streaming-state exporter reported Connect/Registry up and Prometheus counted eight RUNNING connectors. RabbitMQ's in-network Prometheus endpoint returned HTTP 200 and queue series, but host port 15692 is not published by the already-running dev container. Direct SQL showed 8/8 logical replication slots active and the control outbox slot active at about 219 MB retained; it also confirmed the observer role is absent. No shared dependency was restarted or altered.

During the live snapshot, Prometheus correctly did not raise `KafkaBrokerUnavailable`; it showed pending alerts for configured durable consumer-group lag and a firing `ProjectionFreshnessUnknown` while app services were stopped. These are observations of this dev snapshot, not a production baseline.
# Post-integration trace-to-log correlation smoke (2026-09-26)

The integrated local OTel Collector accepts OTLP traces and logs and exports them to Tempo and Loki. A synthetic `greenguard-observability-smoke` span and log were sent to the local collector with matching trace/span IDs. Tempo returned the trace, and Loki returned the log using:

```logql
{service_name="greenguard-observability-smoke"} | trace_id="0123456789abcdef0123456789abcdef"
```

This verifies the Grafana backend drill-down path with synthetic telemetry only. It does not establish application-level correlation across GreenGuard services.

## Isolated PostgreSQL exporter smoke (2026-09-26)

Created/rotated the `greenguard_observer` role only in `greenguard-stage11-isolated-postgres-1` and granted PostgreSQL's `pg_monitor` role. Both the standard exporter (`127.0.0.1:19187`) and replication-slot exporter (`127.0.0.1:19188`) returned `pg_up 1`; Prometheus marked `postgres-exporter` and `postgres-wal-slots` up. Their connection target was the isolated database at host port `55439`. The shared development database was not changed or queried during this exporter check.
