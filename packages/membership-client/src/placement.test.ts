import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  createPlacementResolver,
  httpPlacementFetcher,
  placementEpoch,
  validateTenantRoute,
  PlacementError,
  type TenantRoute,
} from "./placement.js";
import {
  suggestInitialShard,
  type InitialPlacementRing,
} from "./placement-ring.js";

const tenant = randomUUID();

test("placement fetch, parsing and error cleanup share a bounded timeout", async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const fetcher of [
      async () => new Promise<Response>(() => {}),
      async () =>
        ({ status: 200, json: () => new Promise(() => {}) }) as Response,
      async () =>
        ({
          status: 503,
          body: { cancel: () => new Promise(() => {}) },
        }) as unknown as Response,
    ]) {
      const load = httpPlacementFetcher({
        baseUrl: "http://localhost:4000",
        token: "fixture-token",
        timeoutMs: 20,
        fetch: fetcher as typeof fetch,
      });
      await assert.rejects(load(tenant), PlacementError);
    }
  } finally {
    clearInterval(keepAlive);
  }
});
const start = Date.parse("2026-09-28T00:00:00Z");
const route = (extra: Partial<TenantRoute> = {}): TenantRoute => ({
  tenantId: tenant,
  shardId: "s2",
  shardIncarnation: "00000000-0000-4000-8000-000000000002",
  placementEpoch: "9007199254740993",
  state: "active",
  expiresAt: new Date(start + 1_000).toISOString(),
  ...extra,
});
test("placement epochs preserve BIGINT precision and reject noncanonical/overflow input", () => {
  assert.equal(placementEpoch("9007199254740993"), 9007199254740993n);
  for (const bad of ["0", "01", "-1", "9223372036854775808", 1, null])
    assert.throws(() => placementEpoch(bad), PlacementError);
});
test("lease validator rejects tenant mismatch, expiry, excessive TTL and caller hints", () => {
  assert.deepEqual(validateTenantRoute(route(), tenant, start), route());
  for (const bad of [
    null,
    [],
    route({ tenantId: randomUUID() }),
    route({ placementEpoch: "0" }),
    route({ shardId: "../../s1" }),
    route({ shardIncarnation: "invalid" }),
    route({ expiresAt: "invalid" }),
    route({ expiresAt: new Date(start).toISOString() }),
    route({ expiresAt: new Date(start + 2001).toISOString() }),
    { ...route(), shardHint: "s4" },
    route({ state: "unknown" as "active" }),
    (() => {
      const value = { ...route() } as Record<string, unknown>;
      delete value.shardIncarnation;
      return value;
    })(),
  ])
    assert.throws(
      () => validateTenantRoute(bad, tenant, start),
      PlacementError,
    );
});
test("cache serves bounded leases; expiry plus authority outage fails closed", async () => {
  let time = start,
    calls = 0,
    outage = false;
  const resolver = createPlacementResolver({
    now: () => time,
    fetch: async () => {
      calls++;
      if (outage) throw new Error("offline");
      return route();
    },
  });
  const a = await resolver.resolveTenant(tenant);
  a.shardId = "s4";
  assert.equal((await resolver.resolveTenant(tenant)).shardId, "s2");
  assert.equal(calls, 1);
  outage = true;
  time = start + 1001;
  await assert.rejects(resolver.resolveTenant(tenant), {
    code: "placement_unavailable",
  });
  time = start;
  await assert.rejects(resolver.resolveTenant(tenant), {
    code: "placement_unavailable",
  });
});
test("fresh lookup, stale epoch and quiescing admissions are explicit", async () => {
  let current = route();
  let calls = 0;
  const resolver = createPlacementResolver({
    now: () => start,
    fetch: async () => {
      calls++;
      return current;
    },
  });
  await resolver.resolveTenant(tenant);
  await assert.rejects(resolver.resolveTenant(tenant, { expectedEpoch: "1" }), {
    code: "stale_placement_epoch",
  });
  current = route({ state: "quiescing" });
  await assert.rejects(resolver.resolveTenant(tenant, { fresh: true }), {
    code: "tenant_quiescing",
  });
  assert.equal(
    (await resolver.resolveTenant(tenant, { requireActive: false })).state,
    "quiescing",
  );
  assert.equal(calls, 2);
  current = route({ placementEpoch: "1" });
  await assert.rejects(resolver.resolveTenant(tenant, { fresh: true }), {
    code: "placement_authority_invariant_violation",
  });
});
test("invalidation prevents an in-flight response from recreating a cached route", async () => {
  let complete!: (value: unknown) => void;
  const resolver = createPlacementResolver({
    now: () => start,
    fetch: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const pending = resolver.resolveTenant(tenant);
  await Promise.resolve();
  resolver.invalidate(tenant);
  complete(route());
  await assert.rejects(pending, { code: "placement_invalidated" });
});
test("concurrent cache misses share one authority fetch and both succeed", async () => {
  let complete!: (value: unknown) => void,
    calls = 0;
  const resolver = createPlacementResolver({
    now: () => start,
    fetch: () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  const a = resolver.resolveTenant(tenant),
    b = resolver.resolveTenant(tenant);
  await Promise.resolve();
  complete(route());
  assert.deepEqual(await a, route());
  assert.deepEqual(await b, route());
  assert.equal(calls, 1);
});
test("clear cancels all shared loads while a replacement can complete", async () => {
  const completions: ((value: unknown) => void)[] = [];
  const resolver = createPlacementResolver({
    now: () => start,
    fetch: () => new Promise((resolve) => completions.push(resolve)),
  });
  const old = resolver.resolveTenant(tenant);
  await Promise.resolve();
  resolver.clear();
  const replacement = resolver.resolveTenant(tenant);
  await Promise.resolve();
  completions[0]!(route());
  await assert.rejects(old, { code: "placement_invalidated" });
  completions[1]!(route({ placementEpoch: "9007199254740994" }));
  assert.equal((await replacement).placementEpoch, "9007199254740994");
});
test("cache has a bounded entry budget and clear invalidates all entries", async () => {
  let calls = 0;
  const resolver = createPlacementResolver({
    now: () => start,
    maxEntries: 1,
    fetch: async (tenantId) => {
      calls++;
      return route({ tenantId });
    },
  });
  await resolver.resolveTenant(tenant);
  await resolver.resolveTenant(randomUUID());
  await resolver.resolveTenant(tenant);
  assert.equal(calls, 3);
  resolver.clear();
  await resolver.resolveTenant(tenant);
  assert.equal(calls, 4);
  assert.throws(
    () =>
      createPlacementResolver({ fetch: async () => route(), maxEntries: 0 }),
    PlacementError,
  );
  await assert.rejects(resolver.resolveTenant("bad"), {
    code: "invalid_tenant_id",
  });
  await assert.rejects(
    resolver.resolveTenant(tenant, { expectedEpoch: "0" }),
    PlacementError,
  );
});
test("local guard detects fresh-authority regression while its lease remains valid", async () => {
  let current = route();
  const resolver = createPlacementResolver({
    now: () => start,
    fetch: async () => current,
  });
  await resolver.resolveTenant(tenant);
  resolver.invalidate(tenant);
  current = route({ placementEpoch: "1" });
  await assert.rejects(resolver.resolveTenant(tenant), {
    code: "placement_authority_invariant_violation",
  });
  await assert.rejects(resolver.resolveTenant(tenant), {
    code: "placement_authority_invariant_violation",
  });
});
test("expiry, invalidation and eviction fetch primary authority without a lifetime tenant limit", async () => {
  let time = start,
    calls = 0;
  const resolver = createPlacementResolver({
    now: () => time,
    maxEntries: 1,
    fetch: async (id) => {
      calls++;
      return route({
        tenantId: id,
        expiresAt: new Date(time + 1000).toISOString(),
      });
    },
  });
  await resolver.resolveTenant(tenant);
  resolver.invalidate(tenant);
  await resolver.resolveTenant(tenant);
  assert.equal(calls, 2);
  time += 1001;
  await resolver.resolveTenant(tenant);
  assert.equal(calls, 3);
  for (let i = 0; i < 20; i++) await resolver.resolveTenant(randomUUID());
  await assert.rejects(resolver.resolveTenant(tenant, { expectedEpoch: "1" }), {
    code: "stale_placement_epoch",
  });
  assert.equal(calls, 24);
});
test("authenticated HTTP fetcher carries only tenant context and bounds requests", async () => {
  const doFetch = async (url: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(
      String(url),
      `https://control.example/v1/internal/placements/${tenant}`,
    );
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      "Bearer secret",
    );
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    return new Response(JSON.stringify(route()), { status: 200 });
  };
  const fetcher = httpPlacementFetcher({
    baseUrl: "https://control.example",
    token: "secret",
    fetch: doFetch as typeof fetch,
  });
  assert.deepEqual(await fetcher(tenant), route());
  await assert.rejects(fetcher("bad"), PlacementError);
  let cancelled = false;
  const down = httpPlacementFetcher({
    baseUrl: "https://control.example",
    token: "secret",
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503 },
      ),
  });
  await assert.rejects(down(tenant), { code: "placement_unavailable" });
  assert.equal(cancelled, true);
  for (const bad of [0, 5001])
    assert.throws(
      () =>
        httpPlacementFetcher({
          baseUrl: "https://control.example",
          token: "secret",
          timeoutMs: bad,
        }),
      PlacementError,
    );
  for (const baseUrl of [
    "file:///etc/passwd",
    "https://user:pass@control.example",
    "http://control.example",
  ])
    assert.throws(
      () => httpPlacementFetcher({ baseUrl, token: "secret" }),
      PlacementError,
    );
  assert.throws(
    () =>
      httpPlacementFetcher({ baseUrl: "https://control.example", token: "" }),
    PlacementError,
  );
  assert.doesNotThrow(() =>
    httpPlacementFetcher({ baseUrl: "http://127.0.0.1", token: "local" }),
  );
  assert.doesNotThrow(() =>
    httpPlacementFetcher({
      baseUrl: "http://control.svc.cluster.local",
      token: "mesh",
      meshMtls: true,
    }),
  );
});
test("placement fetcher preserves a configured path prefix", async () => {
  const fetcher = httpPlacementFetcher({
    baseUrl: "https://control.example/control",
    token: "secret",
    fetch: async (url) => {
      assert.equal(
        String(url),
        `https://control.example/control/v1/internal/placements/${tenant}`,
      );
      return new Response(JSON.stringify(route()), { status: 200 });
    },
  });
  assert.deepEqual(await fetcher(tenant), route());
});
test("an expected epoch ahead of a cached lease refreshes the primary authority", async () => {
  let current = route({ placementEpoch: "1" }),
    calls = 0;
  const resolver = createPlacementResolver({
    now: () => start,
    fetch: async () => {
      calls++;
      return current;
    },
  });
  await resolver.resolveTenant(tenant);
  current = route({ placementEpoch: "2" });
  assert.equal(
    (await resolver.resolveTenant(tenant, { expectedEpoch: "2" }))
      .placementEpoch,
    "2",
  );
  assert.equal(calls, 2);
  await assert.rejects(resolver.resolveTenant(tenant, { expectedEpoch: "1" }), {
    code: "stale_placement_epoch",
  });
  assert.equal(calls, 2);
});
const ring: InitialPlacementRing = {
  version: "1",
  algorithm: "sha256-v1",
  virtualNodes: 128,
  shardIds: ["s1", "s2", "s3", "s4"],
};
test("initial placement ring is deterministic across ordering/version changes, includes every shard", () => {
  const counts = new Map(ring.shardIds.map((id) => [id, 0]));
  for (let i = 0; i < 500; i++) {
    const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    const selected = suggestInitialShard(id, ring);
    assert.equal(
      selected,
      suggestInitialShard(id, {
        ...ring,
        version: "2",
        shardIds: [...ring.shardIds].reverse(),
      }),
    );
    counts.set(selected, counts.get(selected)! + 1);
  }
  for (const count of counts.values())
    assert.ok(count > 65 && count < 190, String(count));
});
test("adding a shard moves only suggestions selecting that added shard", () => {
  for (let i = 0; i < 100; i++) {
    const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    const before = suggestInitialShard(id, ring);
    const after = suggestInitialShard(id, {
      ...ring,
      version: "2",
      shardIds: [...ring.shardIds, "s5"],
    });
    assert.ok(after === before || after === "s5");
  }
  for (const invalid of [
    { ...ring, virtualNodes: 0 },
    { ...ring, shardIds: [] },
    { ...ring, shardIds: ["s1", "s1"] },
    { ...ring, shardIds: ["../../x"] },
    { ...ring, algorithm: "unknown" as "sha256-v1" },
  ])
    assert.throws(() => suggestInitialShard(tenant, invalid), PlacementError);
  assert.throws(() => suggestInitialShard("bad", ring), PlacementError);
});
