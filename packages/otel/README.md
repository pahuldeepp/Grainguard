# packages/otel

Status: **Node tracing implemented (Stage 02)**. Go, Python, metrics, logs and broker propagation remain planned (Stages 03, 04, 11).

Stages: 02,11.

Technology: OpenTelemetry Go/Node/Python.

Responsibility: Tracer/meter/logger bootstraps and broker propagation.

Use (Node): `initTracing({serviceName, otlpEndpoint | spanExporter, sampleRatio?})` registers a W3C Trace Context provider and returns `{tracer, shutdown}`. `httpTracingMiddleware(tracer)` continues the caller's trace (or starts one) with a server span that stays the active context for the request. `activeTraceparent()` formats the live span as a `traceparent` (only the sampled flag is kept, matching the event contracts), and `annotateActiveSpan(attributes)` adds bounded attributes. Span names replace identifiers with `:id` to stay low-cardinality. `@greenguard/otel/testing` exports an in-memory exporter for tests.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.
