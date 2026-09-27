import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkheadBackends, BulkheadFull } from "./bulkhead.js";
import type { ReadBackends } from "./backends.js";
import { createApp } from "./app.js";
import type { AddressInfo } from "node:net";

const q = (tenantId: string) => ({
  tenantId,
  deviceId: "device",
  from: new Date(0),
  to: new Date(1),
  limit: 1,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
test("cold history protects global and tenant capacity and releases slots", async () => {
  const first = deferred<unknown[]>(),
    second = deferred<unknown[]>();
  let loads = 0;
  const backends: ReadBackends = {
    device: async () => null,
    devices: async () => [],
    reading: async () => null,
    devicesBySite: async () => [],
    latest: async () => null,
    hotReadings: async () => [],
    rollup: async () => [],
    history: {
      list: async () => (++loads === 1 ? first.promise : second.promise),
    },
    search: { search: async () => [] },
  };
  const protectedBackends = bulkheadBackends(backends, {
    historyGlobal: 2,
    historyPerTenant: 1,
  });
  const a = protectedBackends.history.list(q("tenant-a"));
  await assert.rejects(
    protectedBackends.history.list(q("tenant-a")),
    BulkheadFull,
  );
  const b = protectedBackends.history.list(q("tenant-b"));
  await assert.rejects(
    protectedBackends.history.list(q("tenant-c")),
    BulkheadFull,
  );
  assert.equal(loads, 2);
  first.resolve([]);
  second.resolve([]);
  await Promise.all([a, b]);
  assert.deepEqual(await protectedBackends.history.list(q("tenant-a")), []);
});
test("search has an independent pool and errors release its slot", async () => {
  const pending = deferred<unknown[]>();
  let calls = 0;
  const backends: ReadBackends = {
    device: async () => null,
    devices: async () => [],
    reading: async () => null,
    devicesBySite: async () => [],
    latest: async () => null,
    hotReadings: async () => [],
    rollup: async () => [],
    history: { list: async () => [] },
    search: { search: async () => (++calls === 1 ? pending.promise : []) },
  };
  const protectedBackends = bulkheadBackends(backends, {
    searchGlobal: 1,
    searchPerTenant: 1,
  });
  const first = protectedBackends.search.search("tenant-a", "bin", 1);
  await assert.rejects(
    protectedBackends.search.search("tenant-b", "bin", 1),
    BulkheadFull,
  );
  assert.deepEqual(await protectedBackends.history.list(q("tenant-b")), []);
  pending.reject(new Error("search backend failed"));
  await assert.rejects(first, /search backend failed/);
  assert.deepEqual(
    await protectedBackends.search.search("tenant-b", "bin", 1),
    [],
  );
});
test("HTTP returns a retry hint when Cassandra has no origin capacity", async () => {
  const started = deferred<void>();
  const pending = deferred<unknown[]>();
  const backends: ReadBackends = {
    device: async () => null,
    devices: async () => [],
    reading: async () => null,
    devicesBySite: async () => [],
    latest: async () => null,
    hotReadings: async () => [],
    rollup: async () => [],
    history: {
      list: async () => {
        started.resolve();
        return pending.promise;
      },
    },
    search: { search: async () => [] },
  };
  const app = createApp({
    verify: async () => ({
      subject: "user",
      tenantId: "11111111-1111-4111-8111-111111111111",
      roles: ["viewer"],
      expiresAt: new Date(Date.now() + 60_000),
    }),
    backends: bulkheadBackends(backends, {
      historyGlobal: 1,
      historyPerTenant: 1,
    }),
    now: () => new Date("2026-09-24T12:00:00Z"),
  });
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/v1/read/devices/33333333-3333-4333-8333-333333333333/readings?from=2026-09-22T10%3A00%3A00Z&to=2026-09-22T11%3A00%3A00Z`;
  try {
    const first = fetch(url, { headers: { Authorization: "Bearer valid" } });
    await started.promise;
    const rejected = await fetch(url, {
      headers: { Authorization: "Bearer valid" },
    });
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get("Retry-After"), "1");
    assert.deepEqual(await rejected.json(), { code: "read_busy" });
    pending.resolve([]);
    const accepted = await first;
    assert.equal(accepted.status, 200);
    await accepted.arrayBuffer();
  } finally {
    pending.resolve([]);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
