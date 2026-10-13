# Stage 11 isolated live journey and trace inspection

Date: 2026-09-27. Environment: isolated Stage 11 PostgreSQL/Kafka/Connect profile, local OpenTelemetry stack. The shared development database was not used for this run.

## Journey result

The isolated event journey completed successfully:

- Inventory outbox row traversed raw Kafka, CDC transformation, canonical inventory topic, and device binding.
- A poison event was retained in quarantine while the following valid event was applied.
- A process killed mid-stream restarted and replayed with one effect per event.
- The source heartbeat traversed an otherwise idle feed and persisted six partition checkpoints.
- A stale binding feed rejected a new request with `503 binding_feed_stale`; an identical retry returned its receipt.
- New readings were admitted after the feed recovered.

This is live local dependency evidence for the inventory/CDC/binding/freshness recovery slice. It does not exercise a complete risk → projection → notification journey or representative load.

## Trace and log inspection

Tempo search on the running local backend returned application traces from both `telemetry-ingest` and `cdc-transformer`. A sampled `POST /v1/devices/:id/readings` server trace returned HTTP 202. Looking up the traceparent persisted on that exact telemetry outbox row returned the matching CDC producer span under the same trace ID, with the HTTP server span as its parent. This proves causal propagation from the real ingest request through the CDC producer. It does not prove downstream risk, projection, or notification spans.

Loki's label endpoint returned no labels, and a query for the request trace ID returned zero log entries. Therefore trace-to-log correlation is **not proven for this application journey**; only the previously documented synthetic trace/log backend correlation is proven.

The isolated profile's app services were not left running after the test. AWS CloudWatch/Lambda evidence, production contact-point paging, owner-approved SLO targets, representative-load saturation, and trace/log correlation across the full application journey remain open.

## Reproduction context

The run used the checked-in `scripts/events-e2e.mjs` journey against the isolated Compose project/profile and local OTLP endpoint `http://127.0.0.1:14318`. The isolated database exposed PostgreSQL on `127.0.0.1:55439` and PgBouncer on `127.0.0.1:56439`; Kafka was on `127.0.0.1:59092`, Connect on `127.0.0.1:58083`, and Schema Registry on `127.0.0.1:58081`. Connector tasks reported `RUNNING` during the rehearsal.

The trace and log checks were read-only against Tempo `127.0.0.1:13200` and Loki `127.0.0.1:13100`. Runtime trace IDs and entity identifiers are intentionally omitted from this evidence file.
