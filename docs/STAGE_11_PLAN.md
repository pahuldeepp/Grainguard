# Stage 11 — End-to-end observability, SLOs and runbooks

Status: **planned, not started**. Nothing in this document is implemented. It is an
execution plan, written the way `docs/STAGE_09_PLAN.md` was: where existing docs
decide something, the decision is restated with a citation; where they do not, it is
marked **OPEN DECISION**.

Backlog row (`docs/IMPLEMENTATION_BACKLOG.md`, Stage 11): *Complete observability:
OTel collector, metrics/logs/traces, exporters/probes, Grafana, Sentry/profiling,
SLOs/error budgets, runbooks*. Dependency: instrumentation from 02, end-to-end flow
from 08. Exit gate: *one trace crosses all transports; synthetic fault triggers
correct actionable alert; dashboard matches actual labels/routes*.

Coverage IDs owned by this stage (`docs/COVERAGE_MATRIX.md`): S07 (line 102,
Prometheus/Grafana/Loki/Tempo dashboards against real traffic), S08 (line 103,
Postgres/Blackbox exporters and synthetic probes), S10 (line 105, SLIs/SLOs, burn
rate, runbooks, tested alert delivery), X23 (line 156, log shipping profile), X25
(line 158, Grafana alerting/Slack routing with a default test sink), Z11 (line 196,
SLOs distinct from load-test targets, owned jointly with Stage 13).

## 1. What exists today (verified by reading, 2026-09-27)

| Component | State | Evidence |
|---|---|---|
| `infra/observability/` | README only: "planned scaffold; implementation not started" | `infra/observability/README.md` |
| Per-service Prometheus text metrics | **Real, already built** across earlier stages. Each service hand-rolls a fixed-cardinality counter/gauge set and serves it as `text/plain` Prometheus exposition. | `services/telemetry-ingest/metrics.go`, `services/cdc-transformer/metrics.go`, `services/projection-builder/metrics.go`, `services/cache-invalidator/metrics.go`, `services/jobs-worker/metrics.go`, `services/saga-orchestrator/saga/metrics.go`, `services/notification-service/src/metrics.ts` |
| `/metrics` route | **Wired for every Go service** through the shared health handler; TypeScript services (`notification-service`, `read-api`) register it directly in `main.ts`. | `packages/go-common/health.go` (`HealthHandler`, `GET /metrics`) |
| Listen address | Each service reads its own `HTTP_ADDR`/port env var with a code default; none are named or pinned in `.env.example` yet. | `services/telemetry-ingest/main.go:61`, `services/cassandra-writer/main.go:115` |
| Distributed tracing | **Real code with tests.** `@greenguard/otel` provides `initTracing`, W3C traceparent propagation, `httpTracingMiddleware`, low-cardinality `spanName`. Outbox events carry the live span's `traceparent` per ADR-0004. | `packages/otel/src/index.ts`; `docs/adr/0004-tracing.md` |
| Metrics SDK / collector export | **Not implemented.** `@greenguard/otel` exports tracing only — no `initMetrics`, no OTLP metrics exporter, no Prometheus/OTel Collector wiring. | `packages/otel/package.json` (dependencies list has no `@opentelemetry/sdk-metrics` or `@opentelemetry/exporter-metrics-otlp-http`) |
| Log shipping | **Not implemented.** No Promtail/Loki/Vector config anywhere in the tree. | repo-wide search, no matches |
| Prometheus / Alertmanager / Grafana | **Not implemented.** No `prometheus.yml`, alert rule files, `alertmanager.yml`, or Grafana provisioning anywhere in the tree. | repo-wide search, no matches |
| SLO/runbook docs | **Not implemented** beyond the ADR-level lateness/rate-limit policies from Stage 03 (ADR-0006, ADR-0007), which are ingest-specific, not platform SLOs. | `docs/adr/0006-*`, `docs/adr/0007-*` |

`X23`/`X25`'s "GG current config" column cites files in the archived
`GrainGuard-`/`CarePulse` source projects (`infra/docker/grafana/...` in that
archive), not this rebuild — nothing under that path exists in this repository.

## 2. Scope for this stage

Build the platform-wide observability plane on top of the per-service metrics and
tracing that already exist; do not re-invent per-service instrumentation.

1. **11a — Metrics SDK and collector.** Add `initMetrics` to `@greenguard/otel`
   (OTLP metrics exporter, same resource attributes as tracing) for the TypeScript
   services; keep the Go services' hand-rolled exposition (no client library
   dependency) but document their metric names/units/labels in one inventory file
   so Prometheus scrape configs and alert rules have a single source of truth. Stand
   up an OTel Collector (OTLP receiver → Prometheus remote-write + logging exporter)
   as a new `infra/observability/otel-collector/` Compose profile, opt-in like the
   other Stage 10 profiles (ADR-0001).
2. **11b — Prometheus, scrape config, exporters.** `infra/observability/prometheus/`
   with a scrape config listing every service's real `HTTP_ADDR`/metrics path (this
   requires pinning each service's port in `.env.example`, which is currently
   unset — an **OPEN DECISION**, recommendation: one fixed port per service,
   documented next to its `HTTP_ADDR` default, never derived at runtime). Add the
   Postgres exporter and blackbox probes named in S08.
3. **11c — Alerting.** Alert rules per component (broker/CDC lag and quarantine,
   ingest rejection-rate spikes per ADR Q1, saga/lock contention, outbox/inbox
   staleness, HTTP error rate) plus the four burn-rate/error-budget rules from Z11.
   Alertmanager routes to a default test-sink webhook per X25; real Slack/PagerDuty
   routing is separately authorized destination setup, not built here.
4. **11d — Dashboards and logs.** Grafana dashboards whose panels match the actual
   metric names from 11a/11b (S07's "dashboard matches actual labels/routes"
   acceptance line exists specifically to catch drift here). Log shipping profile
   (X23) is a compatibility lab, not a hard dependency of 11a–11c.
5. **11e — SLOs and runbooks.** One runbook per alert (owner, diagnosis steps,
   mitigation, links back to the relevant ADR/service README), and the SLO
   definitions the burn-rate rules in 11c actually implement (p95/p99 per
   endpoint, valid-request denominator, freshness budget) — write the SLO first,
   derive the PromQL from it, not the other way around.

## 3. Acceptance

Per the backlog exit gate: a trace must be shown crossing ingest → Kafka → consumer
→ read model (or an equivalent multi-hop path) with one `traceparent`; a synthetic
fault (kill a consumer, saturate the outbox, force a 5xx burst) must be shown
producing the correct alert, correct severity, correct runbook link and successful
delivery to the test sink, then clearing on recovery; a Grafana dashboard screenshot
or exported JSON must be checked against the live metric names it queries.

## 4. What blocks doing this in a sandboxed session

This plan can be written and reviewed without infrastructure. Building and proving
11a–11e cannot: it needs a running Docker daemon (Compose profile), and rehearsing
11c/11e needs Prometheus/Alertmanager/promtool actually running against synthetic
metrics, the way the ingest crash matrix runs against a real database. A session
with no Docker daemon and no `promtool`/`amtool`/`helm` on `PATH` can produce YAML
that is syntactically valid and internally consistent with the metric names it
matched from source, but cannot rehearse firing → delivery → recovery, and per
`docs/IMPLEMENTATION_BACKLOG.md`'s definition of done, unrehearsed alert config is
not itself acceptance evidence.
