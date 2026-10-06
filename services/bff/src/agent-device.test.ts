import test from "node:test";
import assert from "node:assert/strict";
import { AgentDeviceLookup } from "./agent-device.js";
test("device serial lookup forwards original identity and rejects unknown, ambiguous, foreign serial and oversized replies", async () => {
  const previous = globalThis.fetch;
  try {
    const serial = "DEMO-SENSOR-1",
      id = "ebd4596c-5143-49c9-9cac-9b7647e97df4";
    let status = 200,
      foreign = false,
      oversized = false;
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(String(url)).searchParams.get("serial"), serial);
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer original-user",
      );
      return new Response(
        oversized
          ? "x".repeat(9000)
          : JSON.stringify({
              deviceId: id,
              serialNumber: foreign ? "foreign" : serial,
            }),
        { status },
      );
    };
    const client = new AgentDeviceLookup("http://127.0.0.1:3001");
    const signal = AbortSignal.timeout(2000);
    assert.equal(
      await client.resolve(serial, "Bearer original-user", signal),
      id,
    );
    status = 404;
    await assert.rejects(
      client.resolve(serial, "Bearer original-user", signal),
      { status: 404, code: "device_not_found" },
    );
    status = 409;
    await assert.rejects(
      client.resolve(serial, "Bearer original-user", signal),
      { status: 409, code: "device_lookup_ambiguous" },
    );
    status = 401;
    await assert.rejects(
      client.resolve(serial, "Bearer original-user", signal),
      { status: 401, code: "invalid_claims" },
    );
    status = 200;
    foreign = true;
    await assert.rejects(
      client.resolve(serial, "Bearer original-user", signal),
      { code: "device_lookup_unavailable" },
    );
    foreign = false;
    oversized = true;
    await assert.rejects(
      client.resolve(serial, "Bearer original-user", signal),
      { code: "device_lookup_unavailable" },
    );
  } finally {
    globalThis.fetch = previous;
  }
});
