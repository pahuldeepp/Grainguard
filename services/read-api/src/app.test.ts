import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { ReadPoolBusy } from "./replicas.js";
import type { ReadBackends } from "./backends.js";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import {
  createMembershipCache,
  createMembershipVerifier,
  membershipChangedHandler,
  identityKey,
} from "@greenguard/membership-client";
import type { Principal } from "@greenguard/tenant-auth";

test("local PostgreSQL saturation returns read_busy with bounded retry advice", async () => {
  const api = createApp({
    verify: async () =>
      ({
        tenantId: A,
        roles: ["viewer"],
        subject: "fixture",
        expiresAt: new Date(Date.now() + 60000),
      }) as Principal,
    backends: {
      ...backends,
      device: async () => {
        throw new ReadPoolBusy();
      },
    },
  }).listen(0);
  try {
    const address = api.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/read/devices/${DEVICE}`,
      {
        headers: { authorization: "Bearer fixture" },
      },
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.deepEqual(await response.json(), { code: "read_busy" });
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});

test("a still-valid JWT loses Read API access after membership.changed", async () => {
  const issuer = await createTestIssuer();
  let revoked = false;
  const cache = createMembershipCache({
    fetch: async () =>
      revoked
        ? { tenantId: A, roles: [], version: "2", state: "revoked" }
        : { tenantId: A, roles: ["viewer"], version: "1", state: "active" },
  });
  const verifier = createMembershipVerifier(
    {
      issuer: issuer.issuer,
      audience: issuer.audience,
      keys: { getKey: issuer.getKey },
    },
    cache,
  );
  const api = createApp({ verify: verifier.verify, backends }).listen(0);
  try {
    const address = api.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const bearer = `Bearer ${await issuer.sign({ sub: "alice", tenant_id: B, roles: ["admin"] })}`;
    const call = () =>
      fetch(`http://127.0.0.1:${address.port}/api/v1/read/devices/${DEVICE}`, {
        headers: { Authorization: bearer },
      });
    assert.equal((await call()).status, 200);
    revoked = true;
    await membershipChangedHandler(cache)({
      event_type: "membership.changed",
      tenant_id: A,
      payload: {
        identity_id: identityKey(issuer.issuer, "alice"),
        membership_version: "2",
      },
    });
    const denied = await call();
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, "insufficient_role");
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const DEVICE = "33333333-3333-4333-8333-333333333333";
const calls: Array<[string, string]> = [];
let siteRows: Array<{ device_id: string }> = [];
let siteRequest: { limit: number; after?: string } | undefined;
const backends: ReadBackends = {
  deviceCurrent: async () => ({ device: null, latestReading: null }),
  device: async (tenant) => {
    calls.push(["device", tenant]);
    return { tenant_id: tenant };
  },
  devices: async (tenant, ids) =>
    ids.map((device_id) => ({ tenant_id: tenant, device_id })),
  sites: async (tenant, ids) =>
    ids.map((site_id) => ({ tenant_id: tenant, site_id })),
  bins: async (tenant, ids) =>
    ids.map((bin_id) => ({ tenant_id: tenant, bin_id })),
  reading: async (tenant) => ({ tenant_id: tenant, reading_id: DEVICE }),
  devicesBySite: async (tenant, _siteId, limit, after) => {
    calls.push(["site", tenant]);
    siteRequest = { limit, after };
    return siteRows.map((row) => ({
      tenant_id: tenant,
      device_id: row.device_id,
      site_id: DEVICE,
      bin_id: null,
      serial_number: "sensor",
      status: "active",
      inventory_version: "1",
    }));
  },
  latest: async (tenant) => {
    calls.push(["latest", tenant]);
    return { tenant_id: tenant };
  },
  binReadings: async (tenant) => {
    calls.push(["bin", tenant]);
    return { tenant_id: tenant, readings: [] };
  },
  binTrend: async (query) => {
    calls.push(["trend", query.tenantId]);
    return {
      bins: { tenant_id: query.tenantId },
      buckets: [],
      source: "postgres",
    };
  },
  hotReadings: async (q) => {
    calls.push(["postgres", q.tenantId]);
    return [];
  },
  rollup: async (q) => {
    calls.push(["rollup", q.tenantId]);
    return [];
  },
  history: {
    list: async (q) => {
      calls.push(["cassandra", q.tenantId]);
      return [];
    },
  },
  search: {
    search: async (tenant) => {
      calls.push(["elasticsearch", tenant]);
      return [{ tenant_id: tenant }];
    },
  },
};
test("machine reads use verified tenant and require read:telemetry scope", async () => {
  const machine: Principal = {
    tenantId: A,
    subject: DEVICE,
    roles: [],
    expiresAt: new Date(Date.now() + 60_000),
    principalType: "service",
    scopes: ["read:telemetry"],
  };
  const api = createApp({
    verify: async (header) =>
      header === "Bearer scoped" ? machine : { ...machine, scopes: [] },
    backends,
  }).listen(0);
  try {
    const address = api.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const base = `http://127.0.0.1:${address.port}`;
    const allowed = await fetch(
      `${base}/api/v1/read/devices/${DEVICE}?tenant_id=${B}`,
      { headers: { authorization: "Bearer scoped", "x-tenant-id": B } },
    );
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).data.tenant_id, A);
    const denied = await fetch(`${base}/api/v1/read/devices/${DEVICE}`, {
      headers: { authorization: "Bearer unscoped" },
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, "insufficient_role");
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});
let server: Server, origin: string;
before(async () => {
  server = createApp({
    verify: async (header) => {
      if (header === "Bearer a" || header === "Bearer b")
        return {
          subject: "user",
          tenantId: header === "Bearer a" ? A : B,
          roles: ["viewer"],
          expiresAt: new Date(Date.now() + 10000),
        };
      throw new Error("bad token");
    },
    backends,
    now: () => new Date("2026-09-24T12:00:00Z"),
  }).listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
async function get(path: string, token = "a") {
  const response = await fetch(origin + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}
test("batch lookup and reading use the verified tenant, reject foreign IDs and bound input", async () => {
  const path = "/api/v1/read/devices/batch";
  for (const token of ["a", "b"]) {
    const response = await fetch(
      origin + path + "?tenant_id=" + (token === "a" ? B : A),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deviceIds: [DEVICE, DEVICE] }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, [
      { tenant_id: token === "a" ? A : B, device_id: DEVICE },
    ]);
    const reading = await get(
      `/api/v1/read/readings/${DEVICE}?tenant_id=${token === "a" ? B : A}`,
      token,
    );
    assert.equal(reading.body.data.tenant_id, token === "a" ? A : B);
  }
  const bad = await fetch(origin + path, {
    method: "POST",
    headers: { Authorization: "Bearer a", "Content-Type": "application/json" },
    body: JSON.stringify({ deviceIds: [DEVICE, "bad"] }),
  });
  assert.equal(bad.status, 400);
});
test("site and bin batch lookup derive tenant and validate bounded UUID arrays", async () => {
  const site = await fetch(origin + "/api/v1/read/sites/batch?tenant_id=" + B, {
    method: "POST",
    headers: { Authorization: "Bearer a", "Content-Type": "application/json" },
    body: JSON.stringify({ siteIds: [DEVICE, DEVICE] }),
  });
  assert.equal(site.status, 200);
  assert.deepEqual(
    ((await site.json()) as { data: Array<{ tenant_id: string }> }).data.map(
      (row) => row.tenant_id,
    ),
    [A],
  );
  const bin = await fetch(origin + "/api/v1/read/bins/batch", {
    method: "POST",
    headers: { Authorization: "Bearer b", "Content-Type": "application/json" },
    body: JSON.stringify({ binIds: [DEVICE] }),
  });
  assert.equal(
    ((await bin.json()) as { data: Array<{ tenant_id: string }> }).data[0]
      ?.tenant_id,
    B,
  );
  const invalid = await fetch(origin + "/api/v1/read/bins/batch", {
    method: "POST",
    headers: { Authorization: "Bearer a", "Content-Type": "application/json" },
    body: JSON.stringify({ binIds: ["nope"] }),
  });
  assert.equal(invalid.status, 400);
});
test("tenant identity comes only from verified principal across backends", async () => {
  for (const token of ["a", "b"]) {
    const tenant = token === "a" ? A : B;
    const latest = await get(
      `/api/v1/read/devices/${DEVICE}/latest?tenant_id=${token === "a" ? B : A}`,
      token,
    );
    assert.equal(latest.body.data.tenant_id, tenant);
    const search = await get(
      `/api/v1/read/search?q=bin&tenant_id=${token === "a" ? B : A}`,
      token,
    );
    assert.equal(search.body.data[0].tenant_id, tenant);
  }
  assert.deepEqual(calls.slice(-2), [
    ["latest", B],
    ["elasticsearch", B],
  ]);
});
test("site pages use owner cursor and look one row ahead without accepting tenant override", async () => {
  siteRows = [
    { device_id: "44444444-4444-4444-8444-444444444444" },
    { device_id: "55555555-5555-4555-8555-555555555555" },
  ];
  const page = await get(
    `/api/v1/read/sites/${DEVICE}/devices?limit=1&after=${DEVICE}&tenant_id=${B}`,
  );
  assert.equal(page.status, 200);
  assert.equal(page.body.data.length, 1);
  assert.equal(page.body.nextCursor, siteRows[0]?.device_id);
  assert.deepEqual(siteRequest, { limit: 2, after: DEVICE });
  assert.deepEqual(calls.at(-1), ["site", A]);
  siteRows = [];
});
test("bin readings and trends derive tenant from identity and enforce closed range/resolution enums", async () => {
  const latest = await get(
    `/api/v1/read/bins/${DEVICE}/readings/latest?tenant_id=${B}`,
    "b",
  );
  assert.equal(latest.status, 200);
  assert.equal(latest.body.data.tenant_id, B);
  assert.equal(latest.body.freshness, "not_configured");
  const trend = await get(
    `/api/v1/read/bins/${DEVICE}/readings/trend?window=H6&resolution=AUTO`,
    "b",
  );
  assert.equal(trend.status, 200);
  assert.equal(trend.body.data.bucketSeconds, 300);
  assert.deepEqual(calls.slice(-2), [
    ["bin", B],
    ["trend", B],
  ]);
  for (const query of [
    "window=H25",
    "window=H24&resolution=M1",
    "window=H1&resolution=bad",
  ]) {
    const invalid = await get(
      `/api/v1/read/bins/${DEVICE}/readings/trend?${query}`,
    );
    assert.equal(invalid.status, 400);
  }
});
test("hot history, old history and rollups route to expected storage", async () => {
  const hot = await get(
    `/api/v1/read/devices/${DEVICE}/readings?from=2026-09-24T10%3A00%3A00Z&to=2026-09-24T11%3A00%3A00Z`,
  );
  assert.equal(hot.body.source, "postgres");
  const boundary = await get(
    `/api/v1/read/devices/${DEVICE}/readings?from=2026-09-23T12%3A00%3A00Z&to=2026-09-23T12%3A01%3A00Z`,
  );
  assert.equal(boundary.body.source, "cassandra");
  const cold = await get(
    `/api/v1/read/devices/${DEVICE}/readings?from=2026-09-22T10%3A00%3A00Z&to=2026-09-22T11%3A00%3A00Z`,
  );
  assert.equal(cold.body.source, "cassandra");
  const rollup = await get(
    `/api/v1/read/devices/${DEVICE}/rollups?from=2026-09-24T10%3A00%3A00Z&to=2026-09-24T11%3A00%3A00Z&bucket=hour`,
  );
  assert.equal(rollup.body.source, "postgres");
  assert.deepEqual(calls.slice(-4), [
    ["postgres", A],
    ["cassandra", A],
    ["cassandra", A],
    ["rollup", A],
  ]);
});
test("range and limit bounds reject requests before backend access", async () => {
  const beforeCount = calls.length;
  const bad = await get(
    `/api/v1/read/devices/${DEVICE}/readings?from=2026-08-01T00%3A00%3A00Z&to=2026-09-24T00%3A00%3A00Z`,
  );
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "invalid_range");
  const limit = await get("/api/v1/read/search?q=bin&limit=1000");
  assert.equal(limit.body.code, "invalid_limit");
  assert.equal(calls.length, beforeCount);
});

const readingsPath = `/api/v1/read/devices/${DEVICE}/readings`;
function historyPath(from: string, to = "2026-09-24T11:00:00Z", extra = {}) {
  return `${readingsPath}?${new URLSearchParams({ from, to, ...extra })}`;
}
test("timestamps require zones on both bounds; explicit offsets work", async () => {
  const count = calls.length;
  for (const [from, to] of [
    ["2026-09-24T10:00", "2026-09-24T11:00:00Z"],
    ["2026-09-24T10:00:00Z", "2026-09-24T11:00"],
  ]) {
    const result = await get(historyPath(from, to));
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "invalid_range");
  }
  assert.equal(calls.length, count);
  for (const offset of ["+01:00", "-01:00"]) {
    assert.equal(
      (await get(historyPath(`2026-09-24T09:00:00${offset}`))).status,
      200,
    );
  }
});
test("pruning margin routes just-inside and crossing ranges to history", async () => {
  for (const [from, source] of [
    ["2026-09-23T11:59:59Z", "cassandra"],
    ["2026-09-23T12:00:01Z", "cassandra"],
    ["2026-09-23T12:04:59Z", "cassandra"],
    ["2026-09-23T12:05:00Z", "postgres"],
  ])
    assert.equal((await get(historyPath(from))).body.source, source);
  const result = await get(
    historyPath("2026-09-23T12:01:00Z").replace("/readings?", "/rollups?") +
      "&bucket=hour",
  );
  assert.equal(result.body.code, "rollup_outside_hot_window");
});
test("both backends report full pages as truncated and reject unsupported cursors", async (t) => {
  const row = {
    reading_id: DEVICE,
    observed_at: new Date("2026-09-24T10:00:00Z"),
  };
  t.mock.method(backends, "hotReadings", async () => [row]);
  t.mock.method(backends.history, "list", async () => [row]);
  for (const from of ["2026-09-24T10:00:00Z", "2026-09-22T10:00:00Z"]) {
    const full = await get(historyPath(from, undefined, { limit: "1" }));
    assert.equal(full.body.truncated, true);
    assert.equal(full.body.data.length, 1);
    const partial = await get(historyPath(from, undefined, { limit: "2" }));
    assert.equal(partial.body.truncated, false);
    const cursor = await get(
      historyPath(from, undefined, { cursor: "opaque" }),
    );
    assert.equal(cursor.status, 400);
    assert.equal(cursor.body.code, "invalid_cursor");
  }
});
