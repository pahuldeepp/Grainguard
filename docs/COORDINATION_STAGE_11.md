# Stage 11 work split (worktree `codex/stage-11-observability`)

Two sides edit this worktree: the Codex session and Claude Sonnet agents. One owner per area; do not edit the other side's files (put requests at the bottom).

## Codex session owns

- Instrumentation code in services and packages: `packages/otel`, `packages/go-common` (metrics/health), `services/*/src` and `services/*/*.go` metrics wiring (Postgres pool and query metrics, RED metrics), tracing wiring.
- Existing files `infra/observability/rules/platform.yaml`, `infra/observability/tests/platform.test.yaml`, the three existing Grafana dashboards, existing runbooks (`docs/runbooks/*.md` created before this note), `docs/STAGE_11_PLAN.md`, `evidence/STAGE_11_*` written so far.
- Integration with Stage 10d and the merge onto the accepted main tree.

## Claude Sonnet agents own (new files only)

- SLO agent: `docs/SLOS.md` (PROPOSED, owner approval pending), `infra/observability/rules/slo.yaml`, `infra/observability/tests/slo.test.yaml`, an SLO dashboard `infra/observability/grafana/dashboards/slo.json`, `evidence/STAGE_11_SLO_VALIDATION.md`.
- Broker agent: `infra/observability/rules/brokers.yaml`, `infra/observability/tests/brokers.test.yaml`, `infra/observability/grafana/dashboards/brokers.json`, exporter scrape config in a NEW file `infra/observability/prometheus-brokers.yaml` (merged into prometheus.yaml later by the Codex session), runbooks `docs/runbooks/kafka-*.md`, `docs/runbooks/rabbitmq-*.md`, `evidence/STAGE_11_BROKER_VALIDATION.md`.
- Rehearsal agent: `scripts/observability-*.mjs`, `infra/observability/rehearsal/**` (synthetic metric targets), a runbook link checker, new runbooks `docs/runbooks/rehearsal-*.md`, `evidence/STAGE_11_REHEARSAL_VALIDATION.md`.

Shared files (`Makefile`, `.env.example`, `infra/observability/compose.yaml`, `infra/observability/README.md`, `docs/runbooks/README.md`, `package.json`): small additive exact-match edits only, re-read right before each edit, `git diff -- <file>` after; never prettier --write them.

## Stack rules

Docker has about 7.7 GB and is shared. Start only what a check needs (Prometheus and Alertmanager are enough for rule tests; `promtool` runs from the Prometheus image). Do not stop containers you did not start. No commits or pushes.

## Requests (append below)

- (empty)
- Rehearsal agent: `make observability-runbook-check` currently fails (see `evidence/STAGE_11_REHEARSAL_VALIDATION.md`): 11 alerts are not named in their runbook and the Kafka/RabbitMQ runbooks lack a `Symptom` heading. Owners of those files: name each alert in its runbook and add the missing heading. New alerts in `platform.yaml` need a `SCENARIOS` entry (`scripts/observability-rehearsal-lib.mjs`) or a NOT REHEARSED note; a transient typo (`debezium_postgres_streaming_mill isecondsbehindsource`) in `platform.yaml` was caught by the harness `promtool check rules` and has since changed.

- Integration follow-up: the pasted main-tree `make verify` log reported five failing `jobs-worker` tests. The current isolated worktree now passes `cd services/jobs-worker && go test ./...`; full `make verify` was not rerun because it depends on `db-migrate` against the shared dev database and Stage 10d has not been accepted/integrated. Re-run the full gate after that integration.

- Broker follow-up (2026-09-26): `scripts/kafka-connect.mjs` now validates every checked-in connector JSON before registering the inventory and telemetry connectors. A regression test rejects an outbox connector sharing a database with a heartbeat connector when `message.prefix.exclude.list` is absent. The three checked-in non-heartbeat outbox configs explicitly exclude logical messages; inventory retains its narrow heartbeat include filter. Tests pass. Live Connect read-only inspection found `notification-contacts` and `control-outbox` share `greenguard_control`; the live control connector currently has `message.prefix.exclude.list=.*` and all eight connectors report RUNNING.
- Live slot samples at 06:55:40, 06:56:18, and 06:58:15 UTC showed inventory and notification-contacts confirmed flush LSNs advancing. `control-outbox` remained at `1/5B07C1D8` (about 219 MB behind current WAL) across the samples despite an active slot and RUNNING task. Thus quiet outbox WAL progress is not yet confirmed for control-outbox; it needs investigation with proper Debezium source-offset/JMX telemetry. Do not reset its slot or offsets as a diagnostic.
- Connect access logs do not record a client-side timeout. The closest reapply candidate is `PUT /connectors/control-outbox/config`, which the server completed with HTTP 201 in 4,418 ms; this cannot prove the caller timed out. `POST /connectors/control-outbox/restart?includeTasks=true&onlyFailed=false` returned HTTP 202 in 37 ms. Future `connectRequest` timeout errors now include the method/path and 10-second limit without including request bodies or credentials.
- The running dev Connect container exposes only REST on 8083 and has no JMX environment settings. A temporary read-only JMX scrape could not connect to `connect:9404` (RMI connection refused), so Debezium source metrics cannot explain the stationary slot in this running environment. The isolated compose profile includes a JMX exporter path for a freshly provisioned stack; that path still needs a live scrape check there.
