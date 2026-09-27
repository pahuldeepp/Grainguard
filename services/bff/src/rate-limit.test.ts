import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@greenguard/tenant-auth";
import { createApp } from "./main.js";
import { ProvisioningClient } from "./provisioning.js";
import { operationHash, operations } from "./query-policy.js";
import {
  boundedRateCheck,
  operationCharge,
  redisRateLimiter,
  type RateStore,
} from "./rate-limit.js";

test("rate limit checks have a bounded wait", async () => {
  await assert.rejects(
    boundedRateCheck(new Promise(() => {}), 5),
    /rate_check_timeout/,
  );
});

const principal = (tenantId: string, subject: string): Principal => ({
  tenantId,
  subject,
  roles: ["viewer"],
  expiresAt: new Date(Date.now() + 60_000),
});
test("operation costs separate cheap, history, search, and provisioning traffic", () => {
  assert.deepEqual(operationCharge({ query: operations.deviceCurrent }), {
    group: "read",
    cost: 1,
  });
  assert.deepEqual(operationCharge({ query: operations.deviceSearch }), {
    group: "read",
    cost: 2,
  });
  assert.deepEqual(operationCharge({ query: operations.siteDevices }), {
    group: "read",
    cost: 2,
  });
  assert.deepEqual(operationCharge({ query: operations.alertList }), {
    group: "read",
    cost: 2,
  });
  for (const [name, cost] of [
    ["alertListV2", 2],
    ["alertDetailV2", 1],
    ["alertHistory", 2],
    ["alertNotifications", 5],
    ["binReadingsLatest", 2],
    ["binReadingsTrend", 5],
  ] as const)
    assert.deepEqual(operationCharge({ query: operations[name] }), {
      group: "read",
      cost,
    });
  assert.throws(
    () => operationCharge({ query: "query Other { __typename }" }),
    /unregistered_operation_cost/,
  );
  assert.deepEqual(operationCharge({ query: operations.readingRollups }), {
    group: "read",
    cost: 5,
  });
  assert.deepEqual(
    operationCharge({
      query: operations.deviceHistory,
      variables: { from: "2026-09-01", to: "2026-09-15" },
    }),
    { group: "read", cost: 10 },
  );
  assert.deepEqual(operationCharge({ query: operations.startProvisioning }), {
    group: "provisioning",
    cost: 1,
  });
  assert.deepEqual(operationCharge({ query: operations.acknowledgeAlert }), {
    group: "alertMutation",
    cost: 1,
  });
});
test("alert acknowledgements and provisioning use separate rate buckets", async () => {
  const requests: Array<{ keys: string[]; arguments: string[] }> = [];
  const limiter = redisRateLimiter({
    eval: async (_script, options) => {
      requests.push(options);
      return [1, 0];
    },
  });
  const user = principal("tenant-a", "alice");
  await limiter.check(user, { query: operations.acknowledgeAlert });
  await limiter.check(user, { query: operations.startProvisioning });
  assert.match(requests[0]?.keys[0] ?? "", /alertMutation/);
  assert.match(requests[1]?.keys[0] ?? "", /provisioning/);
  assert.notEqual(requests[0]?.arguments[1], requests[1]?.arguments[1]);
});
test("two replicas use tenant-scoped shared Redis keys and opaque user identifiers", async () => {
  const requests: Array<{ keys: string[]; arguments: string[] }> = [];
  const store: RateStore = {
    eval: async (_script, options) => {
      requests.push(options);
      return [1, 0];
    },
  };
  const a = redisRateLimiter(store),
    b = redisRateLimiter(store);
  await a.check(principal("tenant-a", "user@example.com"), {
    query: operations.deviceSearch,
  });
  await b.check(principal("tenant-a", "user@example.com"), {
    query: operations.deviceSearch,
  });
  await b.check(principal("tenant-b", "user@example.com"), {
    query: operations.deviceSearch,
  });
  assert.deepEqual(requests[0].keys, requests[1].keys);
  assert.notDeepEqual(requests[0].keys, requests[2].keys);
  assert.ok(
    requests[0].keys.every(
      (key) => key.includes("{tenant-a}") && !key.includes("user@example.com"),
    ),
  );
  assert.equal(requests[0].arguments[0], "2");
});
test("machine API keys get a separate tenant-scoped Redis bucket", async () => {
  const requests: Array<{ keys: string[]; arguments: string[] }> = [];
  const limiter = redisRateLimiter({
    eval: async (_script, options) => {
      requests.push(options);
      return [1, 0];
    },
  });
  const machine = {
    ...principal("tenant-a", "service-principal"),
    roles: [] as Principal["roles"],
    principalType: "service" as const,
    scopes: ["read:telemetry"],
  };
  await limiter.check(
    { ...machine, keyId: "key-a" },
    { query: operations.deviceCurrent },
  );
  await limiter.check(
    { ...machine, keyId: "key-b" },
    { query: operations.deviceCurrent },
  );
  assert.deepEqual(
    requests[0]?.keys.slice(0, 2),
    requests[1]?.keys.slice(0, 2),
  );
  assert.notEqual(requests[0]?.keys[2], requests[1]?.keys[2]);
  assert.ok(
    requests[0]?.keys.every(
      (key) => key.includes("{tenant-a}") && !key.includes("key-a"),
    ),
  );
  assert.equal(requests[0]?.arguments.length, 7);
});
test("machine principal may use telemetry reads but cannot run mutations or session", async () => {
  const machine: Principal = {
    ...principal("tenant-a", "service"),
    roles: [],
    principalType: "service",
    scopes: ["read:telemetry"],
  };
  const { app, server } = await createApp({
    verify: async () => machine,
    provisioning: new ProvisioningClient("http://127.0.0.1:1"),
  });
  const listener = app.listen(0);
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("missing_port");
    const call = (query: string) =>
      fetch(`http://127.0.0.1:${address.port}/graphql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer machine",
        },
        body: JSON.stringify({
          extensions: { persistedQuery: { sha256Hash: operationHash(query) } },
        }),
      });
    for (const query of [
      operations.session,
      operations.startProvisioning,
      operations.alertList,
    ]) {
      const denied = await call(query);
      assert.equal(denied.status, 403);
    }
    const read = await call(operations.deviceCurrent);
    assert.notEqual(read.status, 403);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await server.stop();
  }
});
test("BFF rejects exhausted requests before reaching GraphQL with Retry-After", async () => {
  const { app, server } = await createApp({
    verify: async () => principal("tenant-a", "user-a"),
    provisioning: new ProvisioningClient("http://127.0.0.1:1"),
    rateLimiter: redisRateLimiter({ eval: async () => [0, 2200] }),
  });
  const listener = app.listen(0);
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("missing_port");
    const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid",
      },
      body: JSON.stringify({
        extensions: {
          persistedQuery: {
            sha256Hash: operationHash(operations.provisioningStatus),
          },
        },
        variables: { id: "s1" },
      }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "3");
    assert.deepEqual(await response.json(), { code: "rate_limited" });
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await server.stop();
  }
});
