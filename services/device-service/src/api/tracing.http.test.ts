import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { initTracing } from "@greenguard/otel";
import { InMemorySpanExporter } from "@greenguard/otel/testing";
import { createTenant } from "../inventory/repository.js";
import { startApi } from "../testing/api.js";
import { adminQuery } from "../testing/fixtures.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER_SPAN = "00f067aa0ba902b7";

test("a request's server span is the origin trace stored on the outbox event", async () => {
  const exporter = new InMemorySpanExporter();
  const tracing = initTracing({
    serviceName: "device-service",
    spanExporter: exporter,
  });
  const api = await startApi({ tracing });
  try {
    const tenantId = randomUUID();
    await createTenant(api.db, tenantId, "tracing");
    const admin = await api.token(tenantId, ["admin"]);
    const operator = await api.token(tenantId, ["operator"]);
    const site = await api.call("POST", "/v1/sites", {
      headers: { "idempotency-key": randomUUID() },
      token: admin,
      body: { name: "s" },
    });
    exporter.reset();
    const register = (traceparent: string) =>
      api.call("POST", "/v1/devices", {
        token: operator,
        headers: { "idempotency-key": randomUUID(), traceparent },
        body: { serialNumber: `SN-${randomUUID()}`, siteId: site.json?.siteId },
      });
    const stored = async (deviceId: unknown) =>
      (
        await adminQuery<{ traceparent: string }>(
          "SELECT traceparent FROM outbox_events WHERE aggregate_id = $1::uuid",
          [deviceId],
        )
      )[0].traceparent;

    const sampled = await register(`00-${TRACE_ID}-${CALLER_SPAN}-01`);
    assert.equal(sampled.status, 201);
    for (let i = 0; i < 100 && exporter.getFinishedSpans().length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.name, "POST /v1/devices");
    assert.equal(span.spanContext().traceId, TRACE_ID);
    assert.equal(span.parentSpanContext?.spanId, CALLER_SPAN);
    assert.equal(span.attributes["greenguard.tenant_id"], tenantId);
    assert.equal(span.attributes["http.response.status_code"], 201);
    assert.equal(
      await stored(sampled.json?.deviceId),
      `00-${TRACE_ID}-${span.spanContext().spanId}-01`,
    );

    const unsampled = await register(`00-${TRACE_ID}-${CALLER_SPAN}-00`);
    assert.match(
      await stored(unsampled.json?.deviceId),
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[\da-f]{16}-00$/,
    );
    assert.notEqual(
      (await stored(unsampled.json?.deviceId)).split("-")[2],
      CALLER_SPAN,
    );
  } finally {
    await api.close();
  }
});
