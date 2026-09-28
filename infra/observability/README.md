# infra/observability

Status: **Stage 11 local profile implemented; full production signal coverage remains in progress**.

Stages: 11.

Technology: OTel, Prometheus, Grafana, Loki, Tempo.

Responsibility: Live metrics/logs/traces, SLOs, exporters and probes.

## Local profile

From the repository root, set a local Grafana password (or accept the explicitly
local-only default) and run:

```sh
docker compose -f infra/observability/compose.yaml up -d
node scripts/observability-validate.mjs
make observability-test-rules
```

Grafana is at `http://127.0.0.1:3000` (admin / local-only default), Prometheus at
`http://127.0.0.1:19090`, Alertmanager at `http://127.0.0.1:19093`, Tempo at
`http://127.0.0.1:13200`, Loki at `http://127.0.0.1:13100`, and OTLP/HTTP at
`http://127.0.0.1:14318`; the Collector exposes OTLP metrics to Prometheus on
internal port `8890`. Published ports bind loopback. Use `docker compose -f
infra/observability/compose.yaml down` to stop; named volumes retain local data.
The Collector exports OTLP traces to Tempo, metrics to Prometheus, and logs to
Loki's native OTLP endpoint. Loki's `trace_id` metadata supports Grafana's
Tempo-to-logs pivot; keep trace and request identifiers in traces/logs, never
as Prometheus labels.

Dashboards and rules are provisioned from this directory. App targets use their
documented host development ports: telemetry-ingest 8080, CDC 8081, projection
builder 8082, jobs worker 8095, device service 3001, workflow alerts 3004,
notification service 8096, risk engine 8086, and Read API cache metrics at
`http://127.0.0.1:4001/metrics/cache`. The Service / Dependency Health dashboard
shows five-minute hit and miss rates plus hit ratio from
`greenguard_read_cache_events_total{event}`. It shows no ratio when there are no
cache lookups. The cache counter has a bounded event label and no tenant or device
labels. Unavailable apps remain visibly down until started. HTTP RED labels use method,
route template, and status only; probe and metrics requests are excluded. Never
add tenant/device/request identifiers to Prometheus labels. AWS collection is an
opt-in profile. Set `AWS_REGION`, comma-separated `AWS_LAMBDA_FUNCTIONS`, and
`AWS_DYNAMODB_TABLES` allowlists, render the validated config with
`make observability-aws-config`, then run `docker compose -f
infra/observability/compose.yaml --profile aws up -d aws-cloudwatch-exporter`.
The generated file is local-only and ignored by Git. The exporter uses the standard AWS
credential provider chain; prefer workload identity/role credentials outside
local development. It requires CloudWatch read permissions for the selected
metrics. Lambda init duration requires Lambda Insights on the functions. AWS
CloudWatch samples are delayed ten minutes by default, so AWS panels query with
an offset. Host CPU/memory uses node
exporter; service/container-level USE signals still need runtime-specific sources.
SLO targets remain candidates until their SLI boundaries are approved and measured.

`make observability-test-rules` validates and evaluates platform, broker, and SLO
rules against synthetic series. `make observability-runbook-check` checks all
alert/runbook links and required sections. `make observability-rehearse` tests
the platform, selected broker, and fast SLO burn page alerts through pending,
firing, webhook delivery, recovery, and resolved notification using scaled
timings. Other broker and SLO alerts still need sink-based failure rehearsals. The local Alertmanager
receiver is a webhook sink; do not configure real Slack/email destinations in
this local profile.

### Streaming-backbone signals (Kafka, Connect, replication slots, RabbitMQ)

Rules: `rules/brokers.yaml` (tests: `tests/brokers.test.yaml`, included in
`make observability-test-rules`). Dashboard: `grafana/dashboards/brokers.json`.
Scrape jobs are included in `prometheus.yaml`; `prometheus-brokers.yaml` is the
standalone reference fragment.
Optional exporters run under the compose profile `brokers`
(`docker compose -f infra/observability/compose.yaml --profile brokers up -d`):
`streaming-state-exporter` (Connect connector/task state and Schema Registry
reachability) and `postgres-exporter-slots` (replication slot retained WAL).
Kafka lag and partition metrics come from the kafka-exporter in
`infra/kafka/compose.yaml`; RabbitMQ from its built-in Prometheus plugin. Lag alerts
cover only the durable consumer-group allowlist in `rules/brokers.yaml`.

The slot exporter exposes `pg_wal_slot_confirmed_flush_position_bytes`; the
brokers dashboard shows its five-minute delta so operators can tell whether
Debezium is advancing its confirmed flush LSN. This is a byte-position gauge,
not the original PostgreSQL LSN string. The Connect JMX exporter also exposes
Debezium streaming metrics; `JMXHOST` must be the Compose DNS name `connect`
because Java RMI advertises that name to the exporter (a wildcard bind address
such as `0.0.0.0` is not a reachable RMI hostname).

Local storage is bounded for Prometheus (7 days / 2 GB); other backends use local
volumes and should be reset with `docker compose ... down -v` when a clean lab is
needed. Do not use this single-node profile for production availability claims.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.
