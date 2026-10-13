import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { createGateway } from "./server.js";

async function listen(server: Server): Promise<URL> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return new URL(`http://127.0.0.1:${address.port}`);
}

test("a stalled provisioning POST has a bounded deadline and one upstream effect", async () => {
  let effects = 0;
  let forwardedKey: string | string[] | undefined;
  const upstream = createServer((request) => {
    if (request.method === "POST" && request.url === "/v1/provisioning") {
      effects++;
      forwardedKey = request.headers["idempotency-key"];
    }
    // Simulate a lost response after the upstream accepted the request.
  });
  const origin = await listen(upstream);
  const gateway = createGateway({
    bff: origin,
    read: origin,
    saga: origin,
    verify: async () => ({
      subject: "operator",
      tenantId: "11111111-1111-4111-8111-111111111111",
      roles: ["operator"],
      expiresAt: new Date(Date.now() + 60_000),
    }),
    timeoutMs: 100,
  });
  const address = await listen(gateway);
  try {
    const started = performance.now();
    const response = await fetch(new URL("/v1/provisioning", address), {
      method: "POST",
      headers: {
        authorization: "Bearer local",
        "idempotency-key": "same-operation",
      },
      body: "{}",
    });
    const elapsed = performance.now() - started;
    assert.equal(response.status, 504);
    assert.ok(elapsed < 2_000, `deadline exceeded local bound: ${elapsed}ms`);
    assert.equal(effects, 1, "the gateway must not retry an ambiguous POST");
    assert.equal(forwardedKey, "same-operation");
  } finally {
    gateway.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => gateway.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  }
});
