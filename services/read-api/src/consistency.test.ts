import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@greenguard/tenant-auth";
import {
  WATERMARK_REQUEST_HEADER,
  WATERMARK_RESPONSE_HEADER,
  serializeWatermark,
  type ReadLeaseAuthority,
} from "@greenguard/membership-client";
import type { ReadBackends } from "./backends.js";
import { createApp } from "./app.js";
import {
  readContext,
  recordSnapshotWatermark,
  type ReadContext,
} from "./consistency.js";
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  D = "33333333-3333-4333-8333-333333333333";
const watermark = {
  v: 1 as const,
  tenantId: A,
  shardIncarnation: D,
  placementEpoch: "5",
  sequence: "9007199254740993",
};
test("mixed cached and database snapshots certify the oldest exact sequence and reject identity changes", () => {
  const context: ReadContext = { tenantId: A, deadline: Date.now() + 1000 };
  recordSnapshotWatermark(context, watermark);
  recordSnapshotWatermark(context, {
    ...watermark,
    sequence: "9007199254740994",
  });
  assert.equal(context.watermark?.sequence, watermark.sequence);
  recordSnapshotWatermark(context, {
    ...watermark,
    sequence: "9007199254740992",
  });
  assert.equal(context.watermark?.sequence, "9007199254740992");
  assert.throws(
    () =>
      recordSnapshotWatermark(context, { ...watermark, placementEpoch: "6" }),
    /read_freshness_unavailable/,
  );
  assert.throws(
    () => recordSnapshotWatermark(context, { ...watermark, tenantId: B }),
    /read_freshness_unavailable/,
  );
});
const principal = (tenantId: string): Principal =>
  ({
    tenantId,
    subject: "viewer",
    roles: ["viewer"],
    expiresAt: new Date(Date.now() + 60000),
  }) as Principal;
async function api(
  body: (base: string) => Promise<void>,
  backends: ReadBackends,
  readAuthority?: ReadLeaseAuthority,
) {
  const server = createApp({
    verify: async (auth) => principal(auth === "B" ? B : A),
    backends,
    readAuthority,
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    await body(`http://127.0.0.1:${address.port}/api/v1/read`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const base = {
  deviceCurrent: async () => ({ device: null, latestReading: null }),
  device: async () => null,
  devices: async () => [],
  sites: async () => [],
  bins: async () => [],
  reading: async () => null,
  devicesBySite: async () => [],
  latest: async () => null,
  binReadings: async () => null,
  binTrend: async () => ({
    bins: null,
    buckets: [],
    source: "postgres" as const,
  }),
  hotReadings: async () => [],
  rollup: async () => [],
  history: { list: async () => [] },
  search: { search: async () => [] },
} satisfies ReadBackends;
test("concurrent requests isolate minima and return only their actual snapshot watermark", async () => {
  const seen: string[] = [];
  const backend = {
    ...base,
    latest: async (tenant: string) => {
      const context = readContext.getStore()!;
      await new Promise((r) => setTimeout(r, tenant === A ? 10 : 1));
      assert.equal(context.tenantId, tenant);
      seen.push(context.minimum?.sequence ?? "eventual");
      context.watermark = { ...watermark, tenantId: tenant };
      return { tenant_id: tenant };
    },
  };
  await api(async (url) => {
    const [a, b] = await Promise.all([
      fetch(`${url}/devices/${D}/latest`, {
        headers: { [WATERMARK_REQUEST_HEADER]: serializeWatermark(watermark) },
      }),
      fetch(`${url}/devices/${D}/latest`, { headers: { authorization: "B" } }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(
      JSON.parse(a.headers.get(WATERMARK_RESPONSE_HEADER)!).tenantId,
      A,
    );
    assert.equal(
      JSON.parse(b.headers.get(WATERMARK_RESPONSE_HEADER)!).tenantId,
      B,
    );
  }, backend);
  assert.deepEqual(seen.sort(), [watermark.sequence, "eventual"].sort());
});
test("foreign/malformed minima and unsupported store proofs never reach origins", async () => {
  let origins = 0;
  const backend = {
    ...base,
    latest: async () => {
      origins++;
      return null;
    },
    search: {
      search: async () => {
        origins++;
        return [];
      },
    },
    history: {
      list: async () => {
        origins++;
        return [];
      },
    },
  };
  await api(async (url) => {
    for (const token of [
      "broken",
      serializeWatermark({ ...watermark, tenantId: B }),
    ])
      assert.equal(
        (
          await fetch(`${url}/devices/${D}/latest`, {
            headers: { [WATERMARK_REQUEST_HEADER]: token },
          })
        ).status,
        400,
      );
    const headers = {
      [WATERMARK_REQUEST_HEADER]: serializeWatermark(watermark),
    };
    const search = await fetch(`${url}/search?q=device`, { headers });
    assert.equal(search.status, 409);
    const from = new Date(Date.now() - 2 * 86400000).toISOString(),
      to = new Date(Date.now() - 86400000).toISOString();
    const history = await fetch(
      `${url}/devices/${D}/readings?from=${from}&to=${to}`,
      { headers },
    );
    assert.equal(history.status, 409);
  }, backend);
  assert.equal(origins, 0);
});
test("lost response lease rejects a completed query and releases admission", async () => {
  let releases = 0,
    admissions = 0;
  const authority: ReadLeaseAuthority = {
    acquire: async () => ({
      leaseId: B,
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      route: {
        tenantId: A,
        shardId: "s2",
        shardIncarnation: D,
        placementEpoch: "5",
        state: "active",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      },
    }),
    admit: async () => {
      admissions++;
      throw new Error("authority unavailable");
    },
    release: async () => {
      releases++;
    },
  };
  await api(
    async (url) => {
      const response = await fetch(`${url}/devices/${D}/latest`);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get(WATERMARK_RESPONSE_HEADER), null);
    },
    {
      ...base,
      latest: async () => {
        readContext.getStore()!.watermark = watermark;
        return { reading_id: D };
      },
    },
    authority,
  );
  assert.equal(admissions, 1);
  assert.equal(releases, 1);
});

test("ten database reads inside one HTTP operation reuse one lease and one response admission", async () => {
  let acquisitions = 0,
    admissions = 0,
    releases = 0,
    queries = 0;
  const leaseId = B;
  const authority: ReadLeaseAuthority = {
    acquire: async () => {
      acquisitions++;
      return {
        leaseId,
        expiresAt: new Date(Date.now() + 5000).toISOString(),
        route: {
          tenantId: A,
          shardId: "s2",
          shardIncarnation: D,
          placementEpoch: "5",
          state: "active",
          expiresAt: new Date(Date.now() + 1000).toISOString(),
        },
      };
    },
    admit: async (lease) => {
      assert.equal(lease.leaseId, leaseId);
      admissions++;
    },
    release: async (lease) => {
      assert.equal(lease.leaseId, leaseId);
      releases++;
    },
  };
  await api(
    async (url) => {
      assert.equal((await fetch(`${url}/devices/${D}/latest`)).status, 200);
    },
    {
      ...base,
      latest: async () => {
        const context = readContext.getStore()!;
        for (let index = 0; index < 10; index++) {
          assert.equal(readContext.getStore()?.lease?.leaseId, leaseId);
          await Promise.resolve();
          queries++;
          recordSnapshotWatermark(context, watermark);
        }
        return { reading_id: D };
      },
    },
    authority,
  );
  assert.equal(queries, 10);
  assert.equal(acquisitions, 1);
  assert.equal(admissions, 1);
  assert.equal(releases, 1);
});

test("authoritative changed identity is409, not a replica lag or outage recovery signal", async () => {
  let origins = 0,
    releases = 0;
  const authority: ReadLeaseAuthority = {
    acquire: async () => ({
      leaseId: B,
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      route: {
        tenantId: A,
        shardId: "s2",
        shardIncarnation: D,
        placementEpoch: "6",
        state: "active",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      },
    }),
    admit: async () => {},
    release: async () => {
      releases++;
    },
  };
  await api(
    async (url) => {
      const response = await fetch(`${url}/devices/${D}/latest`, {
        headers: { [WATERMARK_REQUEST_HEADER]: serializeWatermark(watermark) },
      });
      assert.equal(response.status, 409);
      assert.equal(
        (await response.json()).code,
        "consistency_identity_mismatch",
      );
    },
    {
      ...base,
      latest: async () => {
        origins++;
        return null;
      },
    },
    authority,
  );
  assert.equal(origins, 0);
  assert.equal(releases, 1);
});

test("read budgets are bounded and malformed budgets do not reach origins", async () => {
  let origins = 0;
  const budgets: number[] = [];
  await api(
    async (url) => {
      for (const value of ["0", "-1", "1.5", "100,200", "x", "99999999999"])
        assert.equal(
          (
            await fetch(`${url}/devices/${D}/latest`, {
              headers: { "x-greenguard-read-budget-ms": value },
            })
          ).status,
          400,
        );
      assert.equal(
        (
          await fetch(`${url}/devices/${D}/latest`, {
            headers: { "x-greenguard-read-budget-ms": "9999999999" },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${url}/devices/${D}/latest`, {
            headers: { "x-greenguard-read-budget-ms": "100" },
          })
        ).status,
        200,
      );
    },
    {
      ...base,
      latest: async () => {
        origins++;
        const ctx = readContext.getStore()!;
        budgets.push(ctx.deadline - Date.now());
        return null;
      },
    },
  );
  assert.equal(origins, 2);
  assert.ok(budgets[0] > 0 && budgets[0] <= 4000);
  assert.ok(budgets[1] > 0 && budgets[1] <= 100);
});

test("expired response budget refuses final admission and releases its lease", async () => {
  let admissions = 0,
    releases = 0;
  const authority: ReadLeaseAuthority = {
    acquire: async () => ({
      leaseId: B,
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      route: {
        tenantId: A,
        shardId: "s2",
        shardIncarnation: D,
        placementEpoch: "5",
        state: "active",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      },
    }),
    admit: async () => {
      admissions++;
    },
    release: async () => {
      releases++;
    },
  };
  await api(
    async (url) => {
      const response = await fetch(`${url}/devices/${D}/latest`, {
        headers: { "x-greenguard-read-budget-ms": "15" },
      });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get(WATERMARK_RESPONSE_HEADER), null);
    },
    {
      ...base,
      latest: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return null;
      },
    },
    authority,
  );
  assert.equal(admissions, 0);
  assert.equal(releases, 1);
});

test("unsupported cold-store minimum rejects before primary entitlement lookup", async () => {
  let lookups = 0;
  const server = createApp({
    verify: async () => principal(A),
    backends: base,
    entitlements: {
      rangeDays: async () => {
        lookups++;
        return { days: 7, planVersion: 1 };
      },
    },
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    const query = new URLSearchParams({
      from: new Date(Date.now() - 2 * 86400000).toISOString(),
      to: new Date(Date.now() - 86400000).toISOString(),
    });
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/read/devices/${D}/readings?${query}`,
      {
        headers: { [WATERMARK_REQUEST_HEADER]: serializeWatermark(watermark) },
      },
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "consistency_store_unsupported");
    assert.equal(lookups, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("expired acquisition returns promptly and releases its late durable lease", async () => {
  let releases = 0,
    origins = 0;
  const authority: ReadLeaseAuthority = {
    acquire: async () => {
      await new Promise((r) => setTimeout(r, 40));
      return {
        leaseId: B,
        expiresAt: new Date(Date.now() + 5000).toISOString(),
        route: {
          tenantId: A,
          shardId: "s2",
          shardIncarnation: D,
          placementEpoch: "5",
          state: "active",
          expiresAt: new Date(Date.now() + 1000).toISOString(),
        },
      };
    },
    admit: async () => {
      throw new Error("must not admit");
    },
    release: async () => {
      releases++;
    },
  };
  await api(
    async (url) => {
      const started = performance.now();
      const response = await fetch(`${url}/devices/${D}/latest`, {
        headers: { "x-greenguard-read-budget-ms": "10" },
      });
      assert.equal(response.status, 503);
      assert.ok(performance.now() - started < 500);
      await new Promise((r) => setTimeout(r, 60));
    },
    {
      ...base,
      latest: async () => {
        origins++;
        return null;
      },
    },
    authority,
  );
  assert.equal(origins, 0);
  assert.equal(releases, 1);
});

test("deadline bounds final authority admission even if authority ignores signal", async () => {
  let releases = 0,
    admissions = 0;
  const authority: ReadLeaseAuthority = {
    acquire: async () => ({
      leaseId: B,
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      route: {
        tenantId: A,
        shardId: "s2",
        shardIncarnation: D,
        placementEpoch: "5",
        state: "active",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      },
    }),
    admit: async (_lease, options) => {
      admissions++;
      assert.ok(options?.signal);
      assert.ok(options?.deadline);
      await new Promise<void>(() => {});
    },
    release: async () => {
      releases++;
    },
  };
  await api(
    async (url) => {
      const response = await fetch(`${url}/devices/${D}/latest`, {
        headers: { "x-greenguard-read-budget-ms": "20" },
      });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get(WATERMARK_RESPONSE_HEADER), null);
    },
    base,
    authority,
  );
  assert.equal(admissions, 1);
  assert.equal(releases, 1);
});
