import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkheadBackends, BulkheadFull } from "./bulkhead.js";
import type { ReadBackends } from "./backends.js";
import { createApp } from "./app.js";
import { readContext } from "./consistency.js";
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
    deviceCurrent: async () => ({ device: null, latestReading: null }),
    device: async () => null,
    devices: async () => [],
    sites: async () => [],
    bins: async () => [],
    reading: async () => null,
    devicesBySite: async () => [],
    latest: async () => null,
    binReadings: async () => null,
    binTrend: async () => ({ bins: null, buckets: [], source: "postgres" }),
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
    deviceCurrent: async () => ({ device: null, latestReading: null }),
    device: async () => null,
    devices: async () => [],
    sites: async () => [],
    bins: async () => [],
    reading: async () => null,
    devicesBySite: async () => [],
    latest: async () => null,
    binReadings: async () => null,
    binTrend: async () => ({ bins: null, buckets: [], source: "postgres" }),
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
    deviceCurrent: async () => ({ device: null, latestReading: null }),
    device: async () => null,
    devices: async () => [],
    sites: async () => [],
    bins: async () => [],
    reading: async () => null,
    devicesBySite: async () => [],
    latest: async () => null,
    binReadings: async () => null,
    binTrend: async () => ({ bins: null, buckets: [], source: "postgres" }),
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

test("bin read admission queues per tenant and schedules another tenant before a hot tenant's backlog", async () => {
  const first = deferred<unknown>(),
    second = deferred<unknown>(),
    third = deferred<unknown>();
  const started: string[] = [];
  const backends: ReadBackends = {
    deviceCurrent: async () => ({ device: null, latestReading: null }),
    device: async () => null,
    devices: async () => [],
    sites: async () => [],
    bins: async () => [],
    reading: async () => null,
    devicesBySite: async () => [],
    latest: async () => null,
    binReadings: async (tenant) => {
      started.push(tenant);
      return started.length === 1
        ? first.promise
        : started.length === 2
          ? second.promise
          : third.promise;
    },
    binTrend: async () => ({ bins: null, buckets: [], source: "postgres" }),
    hotReadings: async () => [],
    rollup: async () => [],
    history: { list: async () => [] },
    search: { search: async () => [] },
  };
  const admitted = bulkheadBackends(backends, {
    readGlobal: 1,
    readPerTenant: 1,
    readWaitMs: 1000,
  });
  const a1 = admitted.binReadings("tenant-a", "bin", new Date());
  const a2 = admitted.binReadings("tenant-a", "bin", new Date());
  const b1 = admitted.binReadings("tenant-b", "bin", new Date());
  assert.deepEqual(started, ["tenant-a"]);
  first.resolve({});
  await a1;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["tenant-a", "tenant-b"]);
  second.resolve({});
  await b1;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["tenant-a", "tenant-b", "tenant-a"]);
  third.resolve({});
  await a2;
});

test("queued aggregate reads retain request context and cancelled work never starts", async () => {
  const first = deferred<{ device: null; latestReading: null }>();
  const seen: string[] = [];
  const wrapped = bulkheadBackends(
    {
      history: { list: async () => [] },
      search: { search: async () => [] },
      deviceCurrent: async (tenant: string) => {
        assert.equal(readContext.getStore()?.tenantId, tenant);
        seen.push(tenant);
        return tenant === "a"
          ? first.promise
          : { device: null, latestReading: null };
      },
    } as unknown as ReadBackends,
    { readGlobal: 1, readPerTenant: 1, readWaitMs: 1000 },
  );
  const controller = new AbortController();
  const a = readContext.run(
    { tenantId: "a", deadline: Date.now() + 1000 },
    () => wrapped.deviceCurrent("a", "device"),
  );
  const b = readContext.run(
    { tenantId: "b", deadline: Date.now() + 1000, signal: controller.signal },
    () => wrapped.deviceCurrent("b", "device"),
  );
  const c = readContext.run(
    { tenantId: "c", deadline: Date.now() + 1000 },
    () => wrapped.deviceCurrent("c", "device"),
  );
  controller.abort();
  await assert.rejects(b, /read_freshness_unavailable/);
  first.resolve({ device: null, latestReading: null });
  await a;
  await c;
  assert.deepEqual(seen, ["a", "c"]);
});
