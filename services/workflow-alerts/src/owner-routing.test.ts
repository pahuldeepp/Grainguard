import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeOwnerDatabase,
  createOwnerDatabase,
} from "@greenguard/membership-client/owner-db";
import type { TenantRoute } from "@greenguard/membership-client";
import { withTenant } from "./db/tenant.js";
import type { Db, Tx } from "./db/client.js";
import { toProblem } from "./api/problem.js";

const a = "10000000-0000-4000-8000-000000000001";
const b = "10000000-0000-4000-8000-000000000002";
const incarnation = "20000000-0000-4000-8000-000000000001";
const manifest = JSON.stringify({
  formatVersion: 1,
  service: "workflow-alerts",
  database: "greenguard_alerts",
  shards: Object.fromEntries(
    [1, 2, 3, 4].map((n) => [
      `s${n}`,
      {
        incarnation,
        primaryUrl: `postgresql://alerts_app:secret@localhost:${6100 + n}/greenguard_alerts`,
        replicaUrls: [],
      },
    ]),
  ),
});
function route(tenantId: string): TenantRoute {
  return {
    tenantId,
    shardId: tenantId === a ? "s1" : "s4",
    shardIncarnation: incarnation,
    placementEpoch: "12",
    state: "active",
    expiresAt: new Date(Date.now() + 1900).toISOString(),
  };
}
function fixture(
  resolve: (tenant: string) => Promise<TenantRoute> = async (t) => route(t),
  deny = false,
  hang = false,
) {
  const calls: Array<{ shard: string; sql: string; params: unknown[] }> = [];
  const closed: string[] = [];
  const db = createOwnerDatabase<Db>({
    legacyUrl: "forbidden",
    env: { SHARD_REGISTRY_FILE: "private", SHARD_LOCAL_LOOPBACK: "true" },
    service: "workflow-alerts",
    database: "greenguard_alerts",
    roles: ["alerts_app"],
    readRegistry: () => manifest,
    resolve,
    create: (_url, shard) =>
      ({
        $transaction: async (work: (tx: Tx) => Promise<unknown>) => {
          let context: unknown[] = [];
          return work({
            $executeRaw: async (
              strings: TemplateStringsArray,
              ...params: unknown[]
            ) => {
              calls.push({ shard: shard!, sql: strings.join("?"), params });
              return 1;
            },
            $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
              calls.push({ shard: shard!, sql, params });
              if (sql.includes("app.tenant_id")) context = params;
              if (sql.includes("admit_tenant_placement")) {
                assert.deepEqual(params, context);
                if (deny) throw new Error("local epoch stale or owner missing");
              }
              return 1;
            },
            $queryRaw: async (
              strings: TemplateStringsArray,
              ...params: unknown[]
            ) => {
              calls.push({ shard: shard!, sql: strings.join("?"), params });
              return [{ tenant_id: context[0], shard }];
            },
          } as unknown as Tx);
        },
        $executeRaw: async (
          strings: TemplateStringsArray,
          ...params: unknown[]
        ) => {
          calls.push({ shard: shard!, sql: strings.join("?"), params });
          return 1;
        },
        $queryRaw: async (
          strings: TemplateStringsArray,
          ...params: unknown[]
        ) => {
          calls.push({ shard: shard!, sql: strings.join("?"), params });
          return [{ tenant_id: a }, { tenant_id: b }];
        },
        $disconnect: async () => {
          closed.push(shard!);
          if (hang) await new Promise(() => {});
        },
      }) as unknown as Db,
    close: (db) => db.$disconnect(),
  });
  return { db, calls, closed };
}

test("simultaneous tenant transactions route separately and admit before business SQL", async () => {
  const { db, calls } = fixture();
  const read = async (tenant: string) =>
    withTenant(
      db,
      tenant,
      (tx) =>
        tx.$queryRaw`SELECT tenant_id FROM tenant_rows WHERE tenant_id=${tenant}::uuid`,
    );
  const [first, second] = await Promise.all([read(a), read(b)]);
  assert.deepEqual(first, [{ tenant_id: a, shard: "s1" }]);
  assert.deepEqual(second, [{ tenant_id: b, shard: "s4" }]);
  for (const [tenant, shard] of [
    [a, "s1"],
    [b, "s4"],
  ]) {
    const owner = calls.filter((c) => c.shard === shard);
    const index = owner.findIndex((c) =>
      c.sql.includes("admit_tenant_placement"),
    );
    assert.ok(index >= 0);
    assert.deepEqual(owner[index].params, [tenant, shard, incarnation, "12"]);
    assert.ok(owner.findIndex((c) => c.sql.includes("tenant_rows")) > index);
  }
  await closeOwnerDatabase(db);
});

test("cross-tenant, wrong shard incarnation, missing and quiescing placement cannot run work", async () => {
  for (const resolve of [
    async () => route(b),
    async () => ({ ...route(a), shardId: "missing" }),
    async () => ({ ...route(a), shardIncarnation: b }),
    async () => ({ ...route(a), state: "quiescing" as const }),
    async () => {
      throw new Error("placement unavailable");
    },
  ]) {
    const { db, calls } = fixture(resolve);
    let worked = false;
    await assert.rejects(
      withTenant(db, a, async () => {
        worked = true;
      }),
    );
    assert.equal(worked, false);
    assert.equal(calls.length, 0);
    await closeOwnerDatabase(db);
  }
});

test("durable missing/stale ownership stops the transaction before business work", async () => {
  const { db } = fixture(undefined, true);
  let worked = false;
  await assert.rejects(
    withTenant(db, a, async () => {
      worked = true;
    }),
    /owner_admission_denied/,
  );
  assert.equal(worked, false);
  await closeOwnerDatabase(db);
});

test("every shard closes and hung shutdown has a caller bound", async () => {
  const { db, closed } = fixture();
  await closeOwnerDatabase(db, 100);
  assert.deepEqual(closed.sort(), ["s1", "s2", "s3", "s4"]);
  const hung = fixture(undefined, false, true);
  const start = Date.now();
  await assert.rejects(closeOwnerDatabase(hung.db, 15), /shutdown_timeout/);
  assert.ok(Date.now() - start < 500);
  assert.equal(hung.closed.length, 4);
});

test("HTTP placement failures have a controlled retryable problem", async () => {
  const { db } = fixture(async () => ({ ...route(a), state: "quiescing" }));
  try {
    await withTenant(db, a, async () => {});
    assert.fail("must deny");
  } catch (error) {
    assert.deepEqual(toProblem(error), {
      status: 503,
      code: "tenant_quiescing",
      headers: { "Retry-After": "1" },
    });
  }
  await closeOwnerDatabase(db);
});
