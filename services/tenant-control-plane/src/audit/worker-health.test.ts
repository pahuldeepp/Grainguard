import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createAuditWorkerHealthServer } from "./worker.js";

test("audit worker health endpoints separate liveness from dependency readiness", async () => {
  let ready = false;
  const server = createAuditWorkerHealthServer(() => ready);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    ready = true;
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
  } finally {
    server.close();
    await once(server, "close");
  }
});
