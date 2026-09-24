# Stage 06 live vertical slice

Run after `make db-migrate`, `make events-up`, `make rabbitmq-up`,
`node scripts/stage06-connect.mjs`, and the TypeScript builds:

```bash
node scripts/stage06-e2e.mjs
```

The script starts local host processes for the CDC transformer, risk engine,
workflow alerts, jobs worker and notification service. It publishes two tenant
streams of binding, grain-lot and telemetry **canonical Kafka events**. Each
reading is within a closed wheat occupancy interval, so the risk engine must
use the event-time lot join. It waits for durable risk assessments, alert
episodes, notification intents and terminal local-provider deliveries. It then
checks that tenant B cannot read tenant A's alert, acknowledges A's episode
with an RS256 operator token and current ETag, kills and restarts the jobs
worker, then replays the original `alert.opened` and reading events. The
replay must leave one risk assessment and episode, and exactly three durable
channel intents per tenant.

This harness begins at canonical Kafka telemetry. Stage 04's `make events-e2e`
separately proves authenticated ingestion through the telemetry outbox and
Debezium. The Stage 06 harness still needs a live run and evidence; syntax or
unit tests alone are not completion. The RabbitMQ broker-restart and DLQ
failure boundaries are exercised separately by `make rabbitmq-test`.
