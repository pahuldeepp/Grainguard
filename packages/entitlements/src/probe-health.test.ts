import assert from "node:assert/strict";
import test from "node:test";
import { startProbeHealth } from "./probe-health.js";

test("worker probes distinguish process liveness from consumer readiness", async (t) => {
  const health = await startProbeHealth({ port: 0 });
  t.after(() => health.close());
  const base = `http://127.0.0.1:${health.port()}`;

  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  health.ready();
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  // No database operation or Kafka message is required while a valid group is idle.
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  health.notReady();
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
});
