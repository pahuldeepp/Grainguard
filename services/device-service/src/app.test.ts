import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";
test("database failures change readiness but not liveness; shutdown closes probe", async () => {
  let failing = false,
    closed = false;
  const app = await createApp({
    async ping() {
      if (failing) throw new Error("secret connection URL");
    },
    async onModuleDestroy() {
      closed = true;
    },
  });
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    failing = true;
    const response = await fetch(`${base}/readyz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      service: "device-service",
      status: "not_ready",
    });
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    await app.close();
  }
  assert.equal(closed, true);
});
