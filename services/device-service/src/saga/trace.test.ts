import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resultHeaders, sagaTrace } from "./trace.js";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

test("a valid saga command trace is kept with only the sampled bit", () => {
  assert.equal(sagaTrace(`00-${TRACE}-${SPAN}-01`), `00-${TRACE}-${SPAN}-01`);
  assert.equal(sagaTrace(`00-${TRACE}-${SPAN}-00`), `00-${TRACE}-${SPAN}-00`);
  assert.equal(sagaTrace(`00-${TRACE}-${SPAN}-03`), `00-${TRACE}-${SPAN}-01`);
});

test("invalid, all-zero or missing traces are dropped, never derived from IDs", () => {
  for (const bad of [
    undefined,
    "",
    `01-${TRACE}-${SPAN}-01`,
    `00-${"0".repeat(32)}-${SPAN}-01`,
    `00-${TRACE}-${"0".repeat(16)}-01`,
    `00-${TRACE.toUpperCase()}-${SPAN}-01`,
    42,
  ])
    assert.equal(sagaTrace(bad), null, String(bad));
});

test("result headers echo the stored trace or carry none", () => {
  const saga = randomUUID();
  const traced = resultHeaders(
    JSON.stringify({
      saga_id: saga,
      tenant_id: "t",
      traceparent: `00-${TRACE}-${SPAN}-01`,
    }),
  );
  assert.deepEqual(traced, {
    traceparent: `00-${TRACE}-${SPAN}-01`,
    correlation_id: saga,
    tenant_id: "t",
  });
  assert.equal(resultHeaders(JSON.stringify({ saga_id: saga })), undefined);
  assert.equal(resultHeaders("not json"), undefined);
});
