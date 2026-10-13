import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { startWorkerHealth, type WorkerHealth } from "./worker-health.js";

const workers: WorkerHealth[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
});

async function status(port: number, path: string): Promise<number> {
  return (await fetch(`http://127.0.0.1:${port}${path}`)).status;
}

test("readiness requires fresh Kafka and successful database activity", async () => {
  let now = 100_000;
  const health = await startWorkerHealth({ port: 0, now: () => now });
  workers.push(health);

  assert.equal(await status(health.port(), "/healthz"), 200);
  assert.equal(await status(health.port(), "/readyz"), 503);

  health.kafkaHeartbeat();
  assert.equal(await status(health.port(), "/readyz"), 503);
  health.databaseSuccess();
  assert.equal(await status(health.port(), "/readyz"), 200);

  now += 15_001;
  assert.equal(await status(health.port(), "/readyz"), 503);
  now += 20_001;
  health.databaseSuccess();
  assert.equal(await status(health.port(), "/readyz"), 503);
  health.kafkaHeartbeat();
  assert.equal(await status(health.port(), "/readyz"), 200);
});

test("health endpoints expose no diagnostics and reject other methods", async () => {
  const health = await startWorkerHealth({ port: 0 });
  workers.push(health);
  const base = `http://127.0.0.1:${health.port()}`;
  const response = await fetch(`${base}/readyz`);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "");
  assert.equal((await fetch(`${base}/readyz`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/unknown`)).status, 404);
});
