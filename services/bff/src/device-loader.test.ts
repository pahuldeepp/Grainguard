import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeviceLoader } from "./device-loader.js";
import { ReadClient } from "./read-client.js";

test("request loader batches distinct IDs, deduplicates repeats, and never reuses a tenant result", async () => {
  const calls: Array<{ auth: string; ids: string[] }> = [];
  const client = new ReadClient("http://127.0.0.1:8093", async (_url, init) => {
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    const ids = (JSON.parse(String(init?.body)) as { deviceIds: string[] })
      .deviceIds;
    calls.push({ auth, ids });
    return Response.json({
      data: ids.map((device_id) => ({ device_id, serial_number: auth })),
    });
  });
  const a = createDeviceLoader(client, "Bearer tenant-a");
  const b = createDeviceLoader(client, "Bearer tenant-b");
  const [first, repeat, second, foreign] = await Promise.all([
    a.load("d1"),
    a.load("d1"),
    a.load("d2"),
    b.load("d1"),
  ]);
  assert.equal(first?.name, "Bearer tenant-a");
  assert.strictEqual(first, repeat);
  assert.equal(second?.deviceId, "d2");
  assert.equal(foreign?.name, "Bearer tenant-b");
  assert.deepEqual(calls, [
    { auth: "Bearer tenant-a", ids: ["d1", "d2"] },
    { auth: "Bearer tenant-b", ids: ["d1"] },
  ]);
});

test("batch response cannot inject an unrequested device", async () => {
  const client = new ReadClient("http://127.0.0.1:8093", async () =>
    Response.json({ data: [{ device_id: "foreign", serial_number: "leak" }] }),
  );
  assert.equal(
    await createDeviceLoader(client, "Bearer tenant-a").load("d1"),
    null,
  );
});
