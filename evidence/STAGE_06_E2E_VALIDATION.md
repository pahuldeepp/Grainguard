# Stage 06 live vertical slice — 2026-09-24

The local PostgreSQL, Kafka/Connect and RabbitMQ services were running with
the Stage 06 owner migrations applied. `make events-up` exited 0 and
`node scripts/stage06-connect.mjs` reported both `risk-outbox` and
`alerts-outbox` connectors and tasks RUNNING.

`node scripts/stage06-e2e.mjs` exited **0**. It used two new tenants and
observed, for each, a committed risk assessment, alert episode, jobs intent
and local-provider sent delivery. It verified tenant B received 404 when
reading tenant A's alert, then acknowledged A's alert with an RS256 operator
token, idempotency key and current ETag. After a jobs-worker SIGKILL/restart,
it republished the original `alert.opened` Kafka event and the original
telemetry event. Each tenant still had exactly three channel intents; tenant
A retained one risk assessment and one episode. The command emitted a Node
`TimeoutNegativeWarning` during KafkaJS administration but did not fail.

A subsequent run after the broader event tests initially timed out: its fresh
risk consumer group encountered unrelated retained records before the test
tenant. The harness now waits for the transformer to catch up on all four raw
outbox topics, then explicitly commits and verifies current canonical-topic
high watermarks for its fresh risk, alert and jobs groups. With that fix, the
full command exited **0** again on 2026-09-24 (local log
`/tmp/greenguard-stage06-e2e-isolated.log`), including the SIGKILL/replay checks.

This test starts at **canonical Kafka telemetry**. Stage 04's independent
`make events-e2e` proves HTTP ingest, telemetry outbox and initial CDC; it is
not the same synthetic reading. The separate `make rabbitmq-test` covers
broker restart, DLQ and redrive failure boundaries. The integrated `make verify`
and `make coverage` runs exited 0. The final local SonarQube gate passed with
89.5% coverage, 0.0% duplication and zero violations. Remote CI evidence is
still required before marking Stage 06 complete.
