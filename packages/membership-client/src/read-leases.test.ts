import assert from "node:assert/strict";
import { test } from "node:test";
import { httpReadLeaseAuthority } from "./read-leases.js";
import { PlacementError } from "./placement.js";
const tenantId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const now = 1_700_000_000_000;
const lease = {
  leaseId,
  expiresAt: new Date(now + 5000).toISOString(),
  route: {
    tenantId,
    shardId: "s2",
    shardIncarnation: leaseId,
    placementEpoch: "3",
    state: "active",
    expiresAt: new Date(now + 1000).toISOString(),
  },
};

test("invalid or expired lease admission rejects without an HTTP request", async () => {
  let calls = 0;
  const client = httpReadLeaseAuthority({
    baseUrl: "https://control.test",
    token: "fixture",
    now: () => now,
    fetch: async () => {
      calls++;
      return Response.json({ admitted: true });
    },
  });
  for (const expiresAt of ["invalid", new Date(now).toISOString()]) {
    await assert.rejects(
      client.admit({
        ...lease,
        expiresAt,
        route: { ...lease.route, state: "active" },
      }),
      PlacementError,
    );
  }
  assert.equal(calls, 0);
});
test("lease client validates authority identity and uses authenticated bounded requests", async () => {
  const calls: { url: string; method: string }[] = [];
  const client = httpReadLeaseAuthority({
    baseUrl: "https://control.test/base",
    token: "lookup",
    now: () => now,
    fetch: async (input, options) => {
      calls.push({ url: String(input), method: options!.method! });
      assert.equal(
        (options!.headers as Record<string, string>).authorization,
        "Bearer lookup",
      );
      assert.equal(options!.redirect, "error");
      assert.ok(options!.signal);
      return Response.json(
        options!.method === "DELETE"
          ? { released: true }
          : String(input).endsWith("/admit")
            ? { admitted: true }
            : lease,
      );
    },
  });
  const result = await client.acquire(tenantId);
  await client.admit(result);
  await client.release(result);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["POST", "POST", "DELETE"],
  );
  assert.ok(
    calls[0].url.includes(
      `/base/v1/internal/placements/${tenantId}/read-leases`,
    ),
  );
});
test("lease outage, foreign tenant, expired lease and non-mTLS HTTP fail closed", async () => {
  assert.throws(
    () =>
      httpReadLeaseAuthority({
        baseUrl: "http://control.test",
        token: "lookup",
      }),
    PlacementError,
  );
  for (const body of [
    null,
    { ...lease, expiresAt: new Date(now).toISOString() },
    { ...lease, route: { ...lease.route, tenantId: leaseId } },
    { ...lease, route: { ...lease.route, state: "quiescing" } },
  ]) {
    const client = httpReadLeaseAuthority({
      baseUrl: "http://127.0.0.1",
      token: "lookup",
      now: () => now,
      fetch: async () => Response.json(body),
    });
    await assert.rejects(client.acquire(tenantId), PlacementError);
  }
  const failed = httpReadLeaseAuthority({
    baseUrl: "https://control.test",
    token: "lookup",
    fetch: async () => {
      throw new Error("secret transport failure");
    },
  });
  await assert.rejects(
    failed.acquire(tenantId),
    (e) => e instanceof PlacementError && !e.message.includes("secret"),
  );
});

test("authority deadline bounds fetch, body parsing and rejected-body cleanup even when mocks ignore cancellation", async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const fetcher of [
      async () => new Promise<Response>(() => {}),
      async () =>
        ({
          ok: true,
          json: async () => new Promise(() => {}),
        }) as unknown as Response,
      async () =>
        ({
          ok: false,
          body: { cancel: async () => new Promise(() => {}) },
        }) as unknown as Response,
    ]) {
      const client = httpReadLeaseAuthority({
        baseUrl: "https://control.test",
        token: "lookup",
        fetch: fetcher,
      });
      const started = performance.now();
      await assert.rejects(
        client.acquire(tenantId, { deadline: Date.now() + 20 }),
        PlacementError,
      );
      assert.ok(performance.now() - started < 500);
    }
    let fetches = 0;
    const controller = new AbortController();
    controller.abort();
    const client = httpReadLeaseAuthority({
      baseUrl: "https://control.test",
      token: "lookup",
      fetch: async () => {
        fetches++;
        return Response.json(lease);
      },
    });
    await assert.rejects(
      client.acquire(tenantId, { signal: controller.signal }),
      PlacementError,
    );
    await assert.rejects(
      client.acquire(tenantId, { deadline: Date.now() - 1 }),
      PlacementError,
    );
    assert.equal(fetches, 0);
  } finally {
    clearInterval(keepAlive);
  }
});
