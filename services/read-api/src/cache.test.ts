import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cacheBackends,
  deviceVersionKey,
  EPOCH_KEY,
  generationKey,
  ReadCache,
  type CacheStore,
} from "./cache.js";
import type { ReadBackends } from "./backends.js";
import { cacheStore, createReadRedis, parseAddressMap } from "./redis.js";

class MemoryRedis implements CacheStore {
  values = new Map<string, { value: string; expires: number }>();
  async get(key: string) {
    const item = this.values.get(key);
    return item && item.expires > Date.now() ? item.value : null;
  }
  async set(key: string, value: string, options: { PX: number; NX?: true }) {
    // Synchronous check-and-set keeps NX atomic like Redis.
    const existing = this.values.get(key);
    if (options.NX && existing && existing.expires > Date.now()) return null;
    this.values.set(key, { value, expires: Date.now() + options.PX });
    return "OK";
  }
  async eval(script: string, options: { keys: string[]; arguments: string[] }) {
    const [key, valueKey] = options.keys;
    if (script.includes("INCR")) {
      const next = Number((await this.get(key)) ?? "0") + 1;
      this.values.set(key, { value: String(next), expires: Infinity });
      return next;
    }
    const holder = (await this.get(key)) === options.arguments[0];
    if (!holder && (!valueKey || (await this.get(valueKey)) !== null))
      return null;
    if (valueKey)
      this.values.set(valueKey, {
        value: options.arguments[1],
        expires: Date.now() + Number(options.arguments[2]),
      });
    else this.values.delete(key);
    return 1;
  }
}
const TENANT_A = "tenant-a";
const DEVICE = "device";
function backend(device: (tenant: string) => Promise<unknown>): ReadBackends {
  return {
    deviceRisk: async () => ({
      status: "no_assessments",
      assessments: [],
      truncated: false,
      validity: "unverified",
      actionable: false,
      caveat: "fixture",
    }),
    deviceCurrent: async () => ({ device: null, latestReading: null }),
    device,
    devices: async () => [],
    sites: async (_t, ids) => ids,
    bins: async (_t, ids) => ids,
    reading: async () => null,
    devicesBySite: async (t) => [t, "site"],
    latest: async (t) => ({ t, latest: true }),
    binReadings: async (t) => ({ t, binReadings: true }),
    binTrend: async (query) => ({
      bins: { tenant_id: query.tenantId },
      buckets: [],
      source: "postgres",
    }),
    hotReadings: async (q) => [{ hot: q.tenantId }] as never,
    rollup: async (_q, bucket) => [bucket],
    history: { list: async () => ["cold"] },
    search: { search: async (_t, q) => [q] },
  };
}
const valueKeys = (redis: MemoryRedis) =>
  [...redis.values.keys()].filter(
    (k) => !k.endsWith(":gen") && !k.endsWith(":lock"),
  );

test("concurrent requests share one origin load and tenant keys remain separate", async () => {
  const redis = new MemoryRedis();
  let loads = 0;
  const reads = cacheBackends(
    backend(async (tenant) => {
      loads++;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { tenant };
    }),
    redis,
    { waitMs: 300 },
  );
  const same = await Promise.all(
    Array.from({ length: 20 }, () => reads.device(TENANT_A, DEVICE)),
  );
  assert.equal(loads, 1);
  assert.ok(same.every((r) => (r as { tenant: string }).tenant === TENANT_A));
  assert.deepEqual(await reads.device("tenant-b", DEVICE), {
    tenant: "tenant-b",
  });
  assert.equal(loads, 2);
  assert.ok(
    valueKeys(redis).some((k) => k.startsWith("gg:read:v1:{t:tenant-a}:g0:")),
  );
  assert.equal(reads.cache.metrics.snapshot().fill, 2);
});

test("every route is cached per tenant and kind", async () => {
  const reads = cacheBackends(
    backend(async () => 1),
    new MemoryRedis(),
  );
  const q = {
    tenantId: TENANT_A,
    deviceId: DEVICE,
    from: new Date(0),
    to: new Date(1),
    limit: 5,
  };
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await reads.devicesBySite(TENANT_A, "s", 5), [
      TENANT_A,
      "site",
    ]);
    assert.deepEqual(await reads.latest(TENANT_A, DEVICE), {
      t: TENANT_A,
      latest: true,
    });
    assert.deepEqual(await reads.hotReadings(q), [{ hot: TENANT_A }]);
    assert.deepEqual(await reads.rollup(q, "day"), ["day"]);
    assert.deepEqual(await reads.history.list(q), ["cold"]);
    assert.deepEqual(await reads.search.search(TENANT_A, "x", 5), ["x"]);
  }
  const m = reads.cache.metrics.snapshot();
  assert.equal(m.hit, 6);
  assert.equal(m.miss, 6);
  assert.match(reads.cache.metrics.prometheus(), /event="hit"} 6/);
});

test("origin errors are not cached and Redis outage falls back to origin", async () => {
  const redis = new MemoryRedis();
  let loads = 0;
  const reads = cacheBackends(
    backend(async () => {
      loads++;
      if (loads === 1) throw new Error("origin unavailable");
      return { ok: true };
    }),
    redis,
  );
  await assert.rejects(reads.device("tenant", DEVICE));
  assert.deepEqual(await reads.device("tenant", DEVICE), { ok: true });
  assert.equal(loads, 2);
  const broken: CacheStore = {
    get: async () => {
      throw new Error("redis unavailable");
    },
    set: redis.set.bind(redis),
    eval: redis.eval.bind(redis),
  };
  const fallback = cacheBackends(
    backend(async () => ({ ok: true })),
    broken,
  );
  assert.deepEqual(await fallback.device("tenant", DEVICE), { ok: true });
  assert.equal(fallback.cache.metrics.snapshot().fallback, 1);
});

test("slow Redis is bounded by the op timeout and opens the breaker", async () => {
  const never = () => new Promise<never>(() => undefined);
  const slow: CacheStore = { get: never, set: never, eval: never };
  let clock = 0;
  const cache = new ReadCache(slow, {
    opTimeoutMs: 5,
    breakerThreshold: 2,
    breakerCooldownMs: 100,
    now: () => clock,
  });
  const started = Date.now();
  for (let i = 0; i < 3; i++)
    assert.equal(await cache.get(TENANT_A, "k", [], async () => i), i);
  assert.ok(Date.now() - started < 200);
  let m = cache.metrics.snapshot();
  assert.equal(m.timeout, 2);
  assert.equal(m.bypass, 1);
  clock = 200;
  assert.equal(await cache.get(TENANT_A, "k", [], async () => 9), 9);
  m = cache.metrics.snapshot();
  assert.equal(m.timeout, 3);
  assert.equal(await cache.invalidateTenant(TENANT_A), false);
});

test("lock or fill failures after a miss still return origin data", async () => {
  const redis = new MemoryRedis();
  const failSet: CacheStore = {
    get: redis.get.bind(redis),
    set: async () => {
      throw new Error("down");
    },
    eval: redis.eval.bind(redis),
  };
  assert.equal(
    await new ReadCache(failSet).get(TENANT_A, "k", [], async () => 1),
    1,
  );
  let gets = 0;
  const failSecondGet: CacheStore = {
    get: async (k) => {
      gets++;
      if (gets === 4) throw new Error("down");
      return redis.get(k);
    },
    set: redis.set.bind(redis),
    eval: redis.eval.bind(redis),
  };
  const cache = new ReadCache(failSecondGet);
  assert.equal(await cache.get(TENANT_A, "k", [], async () => 2), 2);
  assert.equal(cache.metrics.snapshot().fallback, 0);
});

test("tenant envelope mismatch, corrupt entries and invalid tenants are never served", async () => {
  const redis = new MemoryRedis();
  const cache = new ReadCache(redis);
  assert.equal(await cache.get(TENANT_A, "k", [], async () => "a"), "a");
  const [key] = valueKeys(redis);
  // Crafted entry in tenant A's slot claiming to belong to tenant B.
  redis.values.set(key, {
    value: JSON.stringify({ t: "tenant-b", k: key.split(":").pop(), v: "b" }),
    expires: Infinity,
  });
  assert.equal(await cache.get(TENANT_A, "k", [], async () => "a2"), "a2");
  redis.values.set(key, { value: "{not json", expires: Infinity });
  redis.values.delete(`${key}:lock`);
  assert.equal(await cache.get(TENANT_A, "k", [], async () => "a3"), "a3");
  assert.equal(cache.metrics.snapshot().mismatch >= 2, true);
  assert.equal(await cache.get("a}b{", "k", [], async () => "x"), "x");
  assert.equal(await cache.invalidateTenant("a}b{"), false);
  assert.equal(cache.metrics.snapshot().bypass, 1);
});

test("invalidation bumps only the requesting tenant's generation", async () => {
  const redis = new MemoryRedis();
  const cache = new ReadCache(redis);
  let version = 1;
  const load = (t: string) => async () => `${t}:${version}`;
  await cache.get(TENANT_A, "k", [], load(TENANT_A));
  await cache.get("tenant-b", "k", [], load("tenant-b"));
  version = 2;
  assert.equal(
    await cache.get(TENANT_A, "k", [], load(TENANT_A)),
    "tenant-a:1",
  );
  assert.equal(await cache.invalidateTenant(TENANT_A), true);
  assert.equal(
    await cache.get(TENANT_A, "k", [], load(TENANT_A)),
    "tenant-a:2",
  );
  assert.equal(
    await cache.get("tenant-b", "k", [], load("tenant-b")),
    "tenant-b:1",
  );
});

test("oversize and undefined values are served but not cached", async () => {
  const redis = new MemoryRedis();
  const cache = new ReadCache(redis, { maxValueBytes: 64 });
  assert.equal(
    (await cache.get(TENANT_A, "big", [], async () => "x".repeat(100))).length,
    100,
  );
  assert.equal(
    await cache.get(TENANT_A, "none", [], async () => undefined),
    undefined,
  );
  assert.equal(valueKeys(redis).length, 0);
  assert.equal(cache.metrics.snapshot().oversize, 1);
});

test("a waiter past its bound loads without the lock; an expired holder fills only an absent key", async () => {
  const redis = new MemoryRedis();
  const cache = new ReadCache(redis, { lockMs: 60_000, waitMs: 5 });
  let loads = 0;
  const release: Array<(value: string) => void> = [];
  const slow = () => {
    loads++;
    return new Promise<string>((resolve) => {
      release[loads] = resolve;
    });
  };
  const first = cache.get(TENANT_A, "k", [], slow);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cache.metrics.snapshot().lock_acquired, 1);
  const second = cache.get(TENANT_A, "k", [], slow);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(loads, 2);
  const locks = [...redis.values.keys()].filter((key) => key.endsWith(":lock"));
  assert.equal(locks.length, 1);
  redis.values.delete(locks[0]); // Simulate lease expiry before the original holder returns.
  const fresh = await cache.get(TENANT_A, "k", [], async () => "fresh");
  assert.equal(fresh, "fresh");
  release[1]("v1");
  release[2]("v2");
  const results = await Promise.all([first, second]);
  assert.equal(loads, 2);
  assert.equal(results.length, 2);
  const m = cache.metrics.snapshot();
  assert.equal(m.lock_wait_timeout, 1);
  assert.equal(m.fill, 1);
  assert.equal(m.fill_rejected, 1);
  assert.equal(valueKeys(redis).length, 1);
});

test("invalid options and address maps are rejected; clients are built from env", () => {
  const redis = new MemoryRedis();
  assert.throws(
    () => new ReadCache(redis, { ttlMs: 0 }),
    /invalid_cache_timing/,
  );
  assert.throws(
    () => new ReadCache(redis, { waitMs: -1 }),
    /invalid_cache_wait/,
  );
  assert.deepEqual(parseAddressMap("a:1=127.0.0.1:7001, ,b:1=h:2"), {
    "a:1": { host: "127.0.0.1", port: 7001 },
    "b:1": { host: "h", port: 2 },
  });
  assert.deepEqual(parseAddressMap(undefined), {});
  assert.throws(() => parseAddressMap("bad"), /invalid_redis_address_map/);
  assert.equal(createReadRedis({}), null);
  assert.ok(createReadRedis({ READ_REDIS_URL: "redis://127.0.0.1:1" }));
  assert.ok(
    createReadRedis({ READ_REDIS_CLUSTER_NODES: "redis://127.0.0.1:1" }),
  );
  const secure = createReadRedis({
    READ_REDIS_CLUSTER_NODES:
      "rediss://reader:secret@127.0.0.1:1,rediss://reader:secret@127.0.0.1:2",
  });
  const options = (
    secure?.client as unknown as {
      options: {
        redisOptions: { username: string; password: string; tls: object };
      };
    }
  ).options.redisOptions;
  assert.equal(options.username, "reader");
  assert.equal(options.password, "secret");
  assert.ok(options.tls);
  assert.throws(
    () =>
      createReadRedis({
        READ_REDIS_CLUSTER_NODES:
          "redis://reader:secret@127.0.0.1:1,rediss://reader:secret@127.0.0.1:2",
      }),
    /inconsistent_redis_cluster_auth/,
  );
});

test("the ioredis adapter maps NX, PX and EVAL arguments", async () => {
  const calls: unknown[][] = [];
  const fake = {
    get: async (k: string) => (calls.push(["get", k]), "v"),
    set: async (...args: unknown[]) => (calls.push(["set", ...args]), "OK"),
    eval: async (...args: unknown[]) => (calls.push(["eval", ...args]), 1),
    quit: async () => (calls.push(["quit"]), "OK"),
    connect: async () => calls.push(["connect"]),
    ping: async () => calls.push(["ping"]),
  };
  const store = cacheStore(fake as never);
  assert.equal(await store.get("k"), "v");
  await store.set("k", "v", { PX: 10, NX: true });
  await store.set("k", "v", { PX: 10 });
  await store.eval("s", { keys: ["a", "b"], arguments: ["1"] });
  await store.connect();
  await store.close();
  assert.deepEqual(calls, [
    ["get", "k"],
    ["set", "k", "v", "PX", 10, "NX"],
    ["set", "k", "v", "PX", 10],
    ["eval", "s", 2, "a", "b", "1"],
    ["connect"],
    ["ping"],
    ["quit"],
  ]);
});

test("device invalidation clears only that device; a tenant bump clears device reads too", async () => {
  const redis = new MemoryRedis();
  const cache = new ReadCache(redis);
  let version = 1;
  const read = (device: string) =>
    cache.get(
      TENANT_A,
      "latest",
      [device],
      async () => `${device}:${version}`,
      device,
    );
  await read("d1");
  await read("d2");
  const tenantWide = () =>
    cache.get(TENANT_A, "site", [], async () => `site:${version}`);
  await tenantWide();
  version = 2;
  assert.equal(await cache.invalidateDevice(TENANT_A, "d1"), true);
  assert.equal(await read("d1"), "d1:2");
  assert.equal(await read("d2"), "d2:1");
  assert.equal(await tenantWide(), "site:1");
  assert.equal(await redis.get(deviceVersionKey(TENANT_A, "d1")), "1");
  assert.equal(await redis.get(deviceVersionKey("tenant-b", "d1")), null);
  version = 3;
  assert.equal(await cache.invalidateTenant(TENANT_A), true);
  assert.equal(await read("d2"), "d2:3");
  assert.equal(await tenantWide(), "site:3");
  assert.equal(await redis.get(generationKey(TENANT_A)), "1");
  assert.equal(await cache.invalidateDevice(TENANT_A, "bad}device"), false);
  assert.equal(await cache.invalidateDevice("bad}tenant", "d1"), false);
  assert.equal(
    await cache.get(TENANT_A, "latest", [], async () => "raw", "bad}device"),
    "raw",
  );
  assert.equal(cache.metrics.snapshot().bypass, 1);
});

test("a global epoch change is honoured after the refresh interval", async () => {
  const redis = new MemoryRedis();
  let clock = 0;
  const cache = new ReadCache(redis, { epochRefreshMs: 100, now: () => clock });
  let version = 1;
  const read = () =>
    cache.get(TENANT_A, "latest", ["d1"], async () => version, "d1");
  assert.equal(await read(), 1);
  version = 2;
  await redis.set(EPOCH_KEY, "1727000000000", { PX: 1e9 });
  clock = 50;
  assert.equal(await read(), 1, "epoch is cached within the refresh interval");
  clock = 150;
  assert.equal(
    await read(),
    2,
    "entries written before the epoch are never trusted",
  );
  assert.ok(
    [...redis.values.keys()].some((k) => k.includes(":e1727000000000:d")),
  );
  assert.throws(
    () => new ReadCache(redis, { epochRefreshMs: -1 }),
    /invalid_cache_epoch/,
  );
});
