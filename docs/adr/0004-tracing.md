# ADR-0004: W3C trace context with OpenTelemetry, origin trace stored on events

Status: accepted, 2026-09-24 (Stage 02).

- Services use OpenTelemetry with the W3C Trace Context propagator (`traceparent`). A service continues the caller's trace, or starts one, and holds a server span open for each request.
- An event written by a request stores that request span's `traceparent` in its outbox row, so it is the **origin** trace of the event. Later hops (CDC, Kafka producer and consumer, projection, RabbitMQ) start their own spans linked to it; a retry is a new span with the same origin, never a rewrite of the stored value.
- Only the sampled bit of the trace flags is kept, because the event contracts allow `00` or `01`. Malformed or all-zero trace and span IDs from a caller are replaced, never stored.
- Correlation ID (a business request chain) and trace ID (a technical trace) are separate values; both are stored.
- Tracing is enabled by configuration (an OTLP collector endpoint), sampled by ratio at the root with the caller's decision respected, and exported over OTLP/HTTP. Span names never contain identifiers; tenant ID is a span attribute, never a metric label.
- Metrics, structured logs with trace fields, the collector, Tempo and Loki, and Go and Python propagation follow in Stages 03, 04 and 11. The Stage 11 exit proof is a single trace across HTTP, outbox, CDC, Kafka and projection.
