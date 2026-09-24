import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { context, trace } from "@opentelemetry/api";
import {
  activeTraceparent,
  annotateActiveSpan,
  formatTraceparent,
  httpTracingMiddleware,
  initTracing,
  spanName,
  type Tracing,
} from "./index.js";
import { InMemorySpanExporter } from "./testing/exporter.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN = "00f067aa0ba902b7";

interface Harness {
  tracing: Tracing;
  exporter: InMemorySpanExporter;
  seen: (string | undefined)[];
  get(
    path: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number }>;
  close(): Promise<void>;
}

async function harness(
  options: { sampleRatio?: number; status?: number } = {},
): Promise<Harness> {
  const exporter = new InMemorySpanExporter();
  const tracing = initTracing({
    serviceName: "test-service",
    sampleRatio: options.sampleRatio,
    spanExporter: exporter,
  });
  const seen: (string | undefined)[] = [];
  const middleware = httpTracingMiddleware(tracing.tracer);
  const server: Server = createServer((req, res) => {
    middleware(req, res, () => {
      setImmediate(() => {
        seen.push(activeTraceparent());
        annotateActiveSpan({ "greenguard.tenant_id": "t-1" });
        res.statusCode = options.status ?? 200;
        res.end("ok");
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    tracing,
    exporter,
    seen,
    get: (path, headers = {}) =>
      new Promise((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, path, headers },
          (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
          },
        );
        req.on("error", reject);
        req.end();
      }),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await tracing.shutdown();
    },
  };
}

async function finished(h: Harness) {
  for (let i = 0; i < 50 && h.exporter.getFinishedSpans().length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return h.exporter.getFinishedSpans();
}

test("a request continues the caller's trace with a new server span", async () => {
  const h = await harness();
  try {
    await h.get("/v1/devices?limit=5", {
      traceparent: `00-${TRACE_ID}-${PARENT_SPAN}-01`,
    });
    const [span] = await finished(h);
    assert.equal(span.spanContext().traceId, TRACE_ID);
    assert.equal(span.parentSpanContext?.spanId, PARENT_SPAN);
    assert.notEqual(span.spanContext().spanId, PARENT_SPAN);
    assert.equal(span.name, "GET /v1/devices");
    assert.equal(span.attributes["url.path"], "/v1/devices");
    assert.equal(span.attributes["http.response.status_code"], 200);
    assert.equal(span.attributes["greenguard.tenant_id"], "t-1");
    assert.equal(span.resource.attributes["service.name"], "test-service");
    assert.equal(h.seen[0], `00-${TRACE_ID}-${span.spanContext().spanId}-01`);
  } finally {
    await h.close();
  }
});

test("without a valid traceparent a new root trace starts", async () => {
  const h = await harness();
  try {
    await h.get("/healthz");
    await h.get("/healthz", { traceparent: "garbage" });
    await h.get("/healthz", {
      traceparent: `00-${"0".repeat(32)}-${PARENT_SPAN}-01`,
    });
    for (let i = 0; i < 50 && h.exporter.getFinishedSpans().length < 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const spans = h.exporter.getFinishedSpans();
    assert.equal(spans.length, 3);
    for (const span of spans) {
      assert.equal(span.parentSpanContext, undefined);
      assert.match(span.spanContext().traceId, /^[\da-f]{32}$/);
    }
    assert.equal(new Set(spans.map((s) => s.spanContext().traceId)).size, 3);
  } finally {
    await h.close();
  }
});

test("sampling: the ratio applies to new traces and a caller's decision is kept", async () => {
  const off = await harness({ sampleRatio: 0 });
  try {
    await off.get("/x");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(off.exporter.getFinishedSpans().length, 0);
    assert.match(off.seen[0] ?? "", /^00-[\da-f]{32}-[\da-f]{16}-00$/);
    await off.get("/x", { traceparent: `00-${TRACE_ID}-${PARENT_SPAN}-01` });
    const [kept] = await finished(off);
    assert.equal(kept.spanContext().traceId, TRACE_ID);
    assert.match(off.seen[1] ?? "", /-01$/);
  } finally {
    await off.close();
  }
  const on = await harness({ sampleRatio: 1 });
  try {
    await on.get("/x", { traceparent: `00-${TRACE_ID}-${PARENT_SPAN}-00` });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(on.exporter.getFinishedSpans().length, 0);
    assert.match(on.seen[0] ?? "", /-00$/);
  } finally {
    await on.close();
  }
});

test("server errors mark the span as failed", async () => {
  const h = await harness({ status: 503 });
  try {
    await h.get("/v1/devices/3f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d");
    const [span] = await finished(h);
    assert.equal(span.status.code, 2);
    assert.equal(span.name, "GET /v1/devices/:id");
    assert.equal(span.attributes["http.response.status_code"], 503);
  } finally {
    await h.close();
  }
});

test("span names never contain identifiers", () => {
  assert.equal(
    spanName(
      "PATCH",
      "/v1/devices/3f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d/status",
    ),
    "PATCH /v1/devices/:id/status",
  );
  assert.equal(spanName("GET", "/v1/items/12345"), "GET /v1/items/:id");
  assert.equal(spanName("GET", "/v1/devices"), "GET /v1/devices");
});

test("traceparent formatting keeps only the sampled bit", () => {
  const spanContext = { traceId: TRACE_ID, spanId: PARENT_SPAN };
  assert.equal(
    formatTraceparent({ ...spanContext, traceFlags: 3 }),
    `00-${TRACE_ID}-${PARENT_SPAN}-01`,
  );
  assert.equal(
    formatTraceparent({ ...spanContext, traceFlags: 2 }),
    `00-${TRACE_ID}-${PARENT_SPAN}-00`,
  );
});

test("without an active span there is no traceparent and annotating is a no-op", () => {
  assert.equal(activeTraceparent(), undefined);
  assert.doesNotThrow(() => annotateActiveSpan({ a: "b" }));
  assert.equal(trace.getActiveSpan(), undefined);
  assert.equal(context.active() !== undefined, true);
});

test("an OTLP endpoint is used when no exporter is injected, and shutdown resets globals", async () => {
  const tracing = initTracing({
    serviceName: "otlp-service",
    serviceVersion: "1.2.3",
    environment: "test",
    otlpEndpoint: "http://127.0.0.1:1/",
  });
  assert.ok(tracing.tracer);
  await tracing.shutdown();
  assert.equal(trace.getTracer("x").startSpan("s").isRecording(), false);
  await assert.doesNotReject(
    initTracing({ serviceName: "again", otlpEndpoint: "http://127.0.0.1:1" })
      .shutdown,
  );
});
