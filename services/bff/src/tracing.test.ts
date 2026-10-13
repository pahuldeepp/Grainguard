import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { initTracing } from "@greenguard/otel";
import { InMemorySpanExporter } from "@greenguard/otel/testing";
import {
  startTracing,
  stopTracing,
  tracingMiddleware,
  tracedFetch,
  tracedDelegation,
} from "./tracing.js";
test("closed server/client/exchange spans propagate child context without sensitive attributes", async () => {
  const exporter = new InMemorySpanExporter();
  startTracing(
    "bff-test",
    undefined,
    initTracing({ serviceName: "bff-test", spanExporter: exporter }),
  );
  const app = express();
  app.use(tracingMiddleware);
  let forwarded = "";
  const downstream = tracedFetch(async (_input, init) => {
    forwarded = new Headers(init?.headers).get("traceparent") ?? "";
    return new Response("{}", { status: 403 });
  });
  app.post("/v1/assistant/agent", async (_req, res) => {
    await tracedDelegation({ mint: async () => "secret-token" }).mint();
    await downstream("https://owner.invalid/v1/agent/plan", {
      headers: { Authorization: "Bearer secret" },
    });
    res.status(403).json({ error: "denied" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    const original = "00-11111111111111111111111111111111-2222222222222222-01";
    await fetch(`http://127.0.0.1:${address.port}/v1/assistant/agent`, {
      method: "POST",
      headers: { traceparent: original },
    });
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 3);
    assert.ok(
      spans.every(
        (s) => s.spanContext().traceId === "11111111111111111111111111111111",
      ),
    );
    const client = spans.find((s) => s.name === "BFF.gateway.plan")!;
    assert.equal(forwarded.split("-")[2], client.spanContext().spanId);
    assert.notEqual(forwarded, original);
    assert.equal(client.status.code, 2);
    const all = JSON.stringify(
      spans.map((s) => ({
        name: s.name,
        attributes: s.attributes,
        events: s.events,
      })),
    );
    assert.ok(!all.includes("secret"));
    assert.ok(!all.includes("owner.invalid"));
    assert.ok(!all.includes("Authorization"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await stopTracing();
  }
});
test("disabled tracing preserves downstream errors and rejects unsafe collector origins", async () => {
  const expected = new Error("private failure");
  await assert.rejects(
    () =>
      tracedFetch(async () => {
        throw expected;
      })("https://owner.invalid"),
    (e) => e === expected,
  );
  for (const url of [
    "http://public.invalid",
    "https://u:p@public.invalid",
    "https://public.invalid?key=x",
  ])
    assert.throws(() => startTracing("test", url));
});
