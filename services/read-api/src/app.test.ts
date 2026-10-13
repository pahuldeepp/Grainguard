import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { ReadPoolBusy } from "./replicas.js";
import type { HistoryQuery, ReadBackends } from "./backends.js";
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
    historyCursorSecret: "read-api-test-dedicated-cursor-secret-32bytes",
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
  const api = createApp({
    historyCursorSecret: "read-api-test-dedicated-cursor-secret-32bytes",
    verify: verifier.verify,
    backends,
  }).listen(0);
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
  deviceRisk: async () => ({
    status: "no_assessments",
    assessments: [],
    truncated: false,
    validity: "unverified",
    actionable: false,
    caveat: "fixture",
  }),
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
    historyCursorSecret: "read-api-test-dedicated-cursor-secret-32bytes",
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
    historyCursorSecret: "read-api-test-dedicated-cursor-secret-32bytes",
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
  assert.deepEqual(hot.body.sources, { postgres: true, cassandra: false });
  const boundary = await get(
    `/api/v1/read/devices/${DEVICE}/readings?from=2026-09-23T12%3A00%3A00Z&to=2026-09-23T12%3A01%3A00Z`,
  );
  assert.deepEqual(boundary.body.sources, { postgres: false, cassandra: true });
  const cold = await get(
    `/api/v1/read/devices/${DEVICE}/readings?from=2026-09-22T10%3A00%3A00Z&to=2026-09-22T11%3A00%3A00Z`,
  );
  assert.deepEqual(cold.body.sources, { postgres: false, cassandra: true });
  const crossing = await get(
    `/api/v1/read/devices/${DEVICE}/readings?from=2026-09-23T12%3A00%3A00Z&to=2026-09-24T11%3A00%3A00Z`,
  );
  assert.deepEqual(crossing.body.sources, { postgres: true, cassandra: true });
  const rollup = await get(
    `/api/v1/read/devices/${DEVICE}/rollups?from=2026-09-24T10%3A00%3A00Z&to=2026-09-24T11%3A00%3A00Z&bucket=hour`,
  );
  assert.equal(rollup.body.source, "postgres");
  assert.deepEqual(calls.slice(-6), [
    ["postgres", A],
    ["cassandra", A],
    ["cassandra", A],
    ["postgres", A],
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
test("retention seam splits requests and sends the safety margin to Cassandra", async () => {
  const justOlder = await get(historyPath("2026-09-23T11:59:59Z"));
  assert.deepEqual(justOlder.body.sources, { postgres: true, cassandra: true });
  for (const from of ["2026-09-23T12:00:01Z", "2026-09-23T12:04:59Z"])
    assert.deepEqual((await get(historyPath(from))).body.sources, {
      postgres: true,
      cassandra: true,
    });
  assert.deepEqual(
    (await get(historyPath("2026-09-23T12:05:00Z"))).body.sources,
    { postgres: true, cassandra: false },
  );
  const result = await get(
    historyPath("2026-09-23T12:01:00Z").replace("/readings?", "/rollups?") +
      "&bucket=hour",
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.source, "hybrid");
});
test("hybrid history merges, deduplicates and paginates across the seam", async (t) => {
  const recent = {
    reading_id: "44444444-4444-4444-8444-444444444444",
    observed_at: new Date("2026-09-24T10:00:00Z"),
    temperature_c: 21,
  };
  const duplicate = { ...recent, temperature_c: 99 };
  const older = {
    reading_id: "55555555-5555-4555-8555-555555555555",
    observed_at: new Date("2026-09-22T10:00:00Z"),
    temperature_c: 18,
  };
  t.mock.method(backends, "hotReadings", async (q: HistoryQuery) => {
    assert.equal(q.limit, 2, "fetches one lookahead row");
    assert.ok(q.from >= new Date("2026-09-23T12:05:00Z"));
    return q.after ? [] : [recent];
  });
  t.mock.method(backends.history, "list", async (q: HistoryQuery) => {
    assert.equal(q.limit, 2, "fetches one lookahead row");
    assert.ok(q.to <= new Date("2026-09-23T12:05:00Z"));
    return q.after ? [older] : [duplicate, older];
  });
  const from = "2026-09-22T00:00:00Z";
  const to = "2026-09-24T11:00:00Z";
  const first = await get(historyPath(from, to, { limit: "1" }));
  assert.deepEqual(first.body.sources, { postgres: true, cassandra: true });
  assert.equal(first.body.data.length, 1);
  assert.equal(first.body.data[0].reading_id, recent.reading_id);
  assert.equal(
    first.body.data[0].temperature_c,
    21,
    "Postgres wins duplicate IDs",
  );
  assert.equal(typeof first.body.nextCursor, "string");

  const second = await get(
    historyPath(from, to, { limit: "1", after: first.body.nextCursor }),
  );
  assert.equal(second.body.data.length, 1);
  assert.equal(second.body.data[0].reading_id, older.reading_id);
  assert.equal(second.body.nextCursor, null);
  assert.deepEqual(second.body.sources, { postgres: true, cassandra: true });

  const foreign = await get(
    historyPath(from, to, { limit: "1", after: first.body.nextCursor }),
    "b",
  );
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.code, "invalid_cursor");
  assert.equal(
    (await get(historyPath(from, to, { cursor: "legacy" }))).body.code,
    "invalid_cursor",
  );
});

test("empty search browses only the authenticated tenant", async (t) => {
  t.mock.method(
    backends.search,
    "search",
    async (tenant: string, text: string) => {
      assert.equal(text, "");
      return [{ tenant_id: tenant }];
    },
  );
  for (const [token, tenant] of [
    ["a", A],
    ["b", B],
  ]) {
    const result = await get(
      `/api/v1/read/search?q=%20%20&tenant_id=${tenant === A ? B : A}`,
      token,
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.data[0].tenant_id, tenant);
  }
  assert.equal((await get("/api/v1/read/search")).status, 400);
});

test("cold and hybrid rollup HTTP responses average complete tenant-scoped samples", async (t) => {
  const sample = (id: string, time: string, temp: number) => ({
    tenant_id: A,
    device_id: DEVICE,
    reading_id: id,
    observed_at: new Date(time),
    temperature_c: temp,
    relative_humidity_percent: 50,
  });
  t.mock.method(backends.history, "list", async (q: HistoryQuery) => {
    assert.equal(q.tenantId, A);
    assert.equal(q.deviceId, DEVICE);
    assert.ok(q.to <= new Date("2026-09-23T12:05:00Z"));
    return q.from.getTime() === new Date("2026-09-22T00:00:00Z").getTime()
      ? [sample("cold", "2026-09-22T12:00:00Z", 12)]
      : [
          sample("a", "2026-09-23T12:00:00Z", 10),
          sample("b", "2026-09-23T12:01:00Z", 20),
        ];
  });
  t.mock.method(backends, "hotReadings", async (q: HistoryQuery) => {
    assert.equal(q.tenantId, A);
    assert.ok(q.from >= new Date("2026-09-23T12:05:00Z"));
    return [sample("c", "2026-09-23T12:06:00Z", 30)] as never;
  });
  const endpoint = (from: string, to: string) =>
    `/api/v1/read/devices/${DEVICE}/rollups?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&bucket=hour`;
  const cold = await get(
    endpoint("2026-09-22T00:00:00Z", "2026-09-23T00:00:00Z"),
  );
  assert.equal(cold.status, 200);
  assert.equal(cold.body.source, "cassandra");
  assert.equal(cold.body.data[0].avg_temperature_c, 12);
  const hybrid = await get(
    endpoint("2026-09-23T12:00:00Z", "2026-09-23T13:00:00Z"),
  );
  assert.equal(hybrid.status, 200);
  assert.equal(hybrid.body.source, "hybrid");
  assert.equal(hybrid.body.data[0].sample_count, 3);
  assert.equal(hybrid.body.data[0].avg_temperature_c, 20);
  t.mock.method(backends.history, "list", async () => {
    throw new Error("cold store unavailable");
  });
  assert.equal(
    (await get(endpoint("2026-09-23T12:00:00Z", "2026-09-23T13:00:00Z")))
      .status,
    503,
  );
});

test("history cursor follows an advancing retention seam without missing pruned rows", async () => {
  let now = new Date("2026-09-24T12:00:00Z");
  const record = (id: string, time: string) => ({
    tenant_id: A,
    device_id: DEVICE,
    reading_id: id,
    observed_at: new Date(time),
    temperature_c: 20,
  });
  const recent = record(
    "44444444-4444-4444-8444-444444444444",
    "2026-09-24T10:00:00Z",
  );
  const pruned = record(
    "55555555-5555-4555-8555-555555555555",
    "2026-09-23T12:06:00Z",
  );
  const api = createApp({
    historyCursorSecret: "read-api-test-dedicated-cursor-secret-32bytes",
    verify: async () =>
      ({
        tenantId: A,
        roles: ["viewer"],
        subject: "fixture",
        expiresAt: new Date(Date.now() + 60000),
      }) as Principal,
    now: () => now,
    backends: {
      ...backends,
      hotReadings: async (q) => {
        if (!q.after) return [recent, pruned] as never;
        assert.equal(q.from.toISOString(), "2026-09-23T12:11:00.000Z");
        return [];
      },
      history: {
        list: async (q) => {
          if (!q.after) return [];
          assert.equal(q.to.toISOString(), "2026-09-23T12:11:00.000Z");
          return [pruned];
        },
      },
    },
  }).listen(0);
  try {
    const address = api.address() as AddressInfo;
    const path = `http://127.0.0.1:${address.port}/api/v1/read/devices/${DEVICE}/readings?from=2026-09-22T00:00:00Z&to=2026-09-24T11:00:00Z&limit=1`;
    const first = await (
      await fetch(path, { headers: { authorization: "Bearer fixture" } })
    ).json();
    assert.equal(first.data[0].reading_id, recent.reading_id);
    assert.ok(first.nextCursor);
    now = new Date("2026-09-24T12:06:00Z");
    const second = await (
      await fetch(path + "&after=" + encodeURIComponent(first.nextCursor), {
        headers: { authorization: "Bearer fixture" },
      })
    ).json();
    assert.equal(second.data[0].reading_id, pruned.reading_id);
    assert.equal(second.nextCursor, null);
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});

test("Read API rejects missing dedicated cursor secret despite database and lookup credentials", () => {
  const saved = {
    secret: process.env.READ_HISTORY_CURSOR_SECRET,
    lookup: process.env.CONTROL_LOOKUP_TOKEN,
    database: process.env.READ_QUERY_DATABASE_URL,
  };
  try {
    delete process.env.READ_HISTORY_CURSOR_SECRET;
    process.env.CONTROL_LOOKUP_TOKEN =
      "private-looking-lookup-credential-32bytes";
    process.env.READ_QUERY_DATABASE_URL =
      "postgresql://private:credential@localhost/read";
    assert.throws(
      () =>
        createApp({
          backends,
          verify: async () => {
            throw new Error("unused");
          },
        }),
      /READ_HISTORY_CURSOR_SECRET/,
    );
  } finally {
    for (const [key, value] of [
      ["READ_HISTORY_CURSOR_SECRET", saved.secret],
      ["CONTROL_LOOKUP_TOKEN", saved.lookup],
      ["READ_QUERY_DATABASE_URL", saved.database],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  }
});

test("MCP read delegation is confined to bounded owning device fact endpoints", async () => {
  const api = createApp({
    historyCursorSecret: "read-api-test-dedicated-cursor-secret-32bytes",
    verify: async () =>
      ({
        tenantId: A,
        subject: "scoped",
        roles: ["viewer"],
        expiresAt: new Date(Date.now() + 60000),
        actor: "greenguard-mcp",
        audience: "read-api",
        scopes: ["telemetry:read"],
      }) as Principal,
    backends,
  }).listen(0);
  try {
    const address = api.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api/v1/read/devices/${DEVICE}`;
    const now = new Date();
    const from = new Date(now.getTime() - 60_000).toISOString();
    const range = `?from=${from}&to=${now.toISOString()}&limit=1`;
    for (const suffix of [
      "/latest",
      "/current",
      "/readings" + range,
      "/rollups" + range + "&bucket=hour",
      "/risk" + range,
    ]) {
      assert.equal(
        (
          await fetch(base + suffix, {
            headers: { Authorization: "Bearer delegated" },
          })
        ).status,
        200,
        suffix,
      );
    }
    for (const suffix of ["", "/history", "/risk/anything"]) {
      assert.equal(
        (
          await fetch(base + suffix, {
            headers: { Authorization: "Bearer delegated" },
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await fetch(base + "/risk" + range, {
          method: "POST",
          headers: { Authorization: "Bearer delegated" },
        })
      ).status,
      403,
    );
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});
