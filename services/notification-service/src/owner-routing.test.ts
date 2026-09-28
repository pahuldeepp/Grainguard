import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import {
  closeOwnerDatabase,
  createOwnerDatabase,
} from "@greenguard/membership-client/owner-db";
import type { TenantRoute } from "@greenguard/membership-client";
import { withTenant } from "./tenant.js";
import { handleTask, type Deps } from "./worker.js";
import {
  FakeBroker,
  incoming,
  makeTask,
  testPolicy,
} from "./testing/fixtures.js";
import { Metrics } from "./metrics.js";
import { Semaphore } from "./pool.js";

const a = "10000000-0000-4000-8000-000000000001";
const b = "10000000-0000-4000-8000-000000000002";
const incarnation = "20000000-0000-4000-8000-000000000001";
const manifest = JSON.stringify({
  formatVersion: 1,
  service: "notification-service",
  database: "greenguard_notifications",
  shards: Object.fromEntries(
    [1, 2, 3, 4].map((n) => [
      `s${n}`,
      {
        incarnation,
        primaryUrl: `postgresql://notifications_app:secret@localhost:${6200 + n}/greenguard_notifications`,
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
  resolve: (
    tenant: string,
    demand?: { fresh?: boolean },
  ) => Promise<TenantRoute> = async (t) => route(t),
  deny = false,
  hang = false,
) {
  const calls: Array<{
    shard: string;
    sql: string;
    params: unknown[];
    session: number;
  }> = [];
  const closed: string[] = [];
  const released: number[] = [];
  let serial = 0;
  const statuses = new Map<string, string>();
  const pool = createOwnerDatabase<Pool>({
    legacyUrl: "forbidden",
    env: { SHARD_REGISTRY_FILE: "private", SHARD_LOCAL_LOOPBACK: "true" },
    service: "notification-service",
    database: "greenguard_notifications",
    roles: ["notifications_app"],
    readRegistry: () => manifest,
    resolve,
    create: (_url, shard) =>
      ({
        connect: async () => {
          const session = ++serial;
          let tenant: unknown;
          return {
            query: async (sql: string, params: unknown[] = []) => {
              calls.push({ shard: shard!, sql, params, session });
              if (sql.includes("app.tenant_id")) tenant = params[0];
              if (sql.includes("admit_tenant_placement")) {
                assert.equal(params[0], tenant);
                if (deny) throw new Error("stale epoch/missing ownership");
              }
              if (sql.includes("INSERT INTO deliveries")) {
                if (!statuses.has(params[1] as string))
                  statuses.set(params[1] as string, "received");
              }
              if (sql.includes("UPDATE deliveries SET status = 'in_progress'"))
                statuses.set(params[1] as string, "in_progress");
              if (sql.includes("UPDATE deliveries SET status = $3"))
                statuses.set(params[1] as string, params[2] as string);
              if (sql.includes("FROM deliveries"))
                return {
                  rows: [
                    {
                      status: statuses.get(params[1] as string) ?? "received",
                      attempts: 0,
                      reconciles: 0,
                      delivery_generation: 0,
                    },
                  ],
                  rowCount: 1,
                };
              if (sql.includes("RETURNING attempt_no"))
                return { rows: [{ n: 1 }], rowCount: 1 };
              if (sql.includes("SELECT tenant_rows"))
                return { rows: [{ tenant, shard }], rowCount: 1 };
              return { rows: [], rowCount: 1 };
            },
            release: () => released.push(session),
          } as unknown as PoolClient;
        },
        end: async () => {
          closed.push(shard!);
          if (hang) await new Promise(() => {});
        },
      }) as unknown as Pool,
    close: (pool) => pool.end(),
  });
  return { pool, calls, closed, released };
}

test("concurrent tenants use separate admitted transactions and release pooled contexts", async () => {
  const { pool, calls, released } = fixture();
  const read = (tenant: string) =>
    withTenant(pool, tenant, (client) =>
      client.query("SELECT tenant_rows WHERE tenant_id=$1", [tenant]),
    );
  const [first, second] = await Promise.all([read(a), read(b)]);
  assert.deepEqual(first.rows, [{ tenant: a, shard: "s1" }]);
  assert.deepEqual(second.rows, [{ tenant: b, shard: "s4" }]);
  for (const session of [1, 2]) {
    const sql = calls.filter((c) => c.session === session);
    assert.equal(sql[0].sql, "BEGIN");
    assert.ok(
      sql.findIndex((c) => c.sql.includes("admit_tenant_placement")) <
        sql.findIndex((c) => c.sql.includes("tenant_rows")),
    );
    assert.equal(sql.at(-1)?.sql, "COMMIT");
  }
  assert.deepEqual(released.sort(), [1, 2]);
  await closeOwnerDatabase(pool);
});

test("wrong/cross-tenant/missing/quiescing routes never allocate a session or provider effect", async () => {
  for (const resolve of [
    async () => route(b),
    async () => ({ ...route(a), shardId: "missing" }),
    async () => ({ ...route(a), shardIncarnation: b }),
    async () => ({ ...route(a), state: "quiescing" as const }),
    async () => {
      throw new Error("authority unavailable");
    },
  ]) {
    const { pool, calls } = fixture(resolve);
    let worked = false;
    await assert.rejects(
      withTenant(pool, a, async () => {
        worked = true;
      }),
    );
    assert.equal(worked, false);
    assert.equal(calls.length, 0);
    await closeOwnerDatabase(pool);
  }
});

test("durable stale/missing placement rolls back and releases before business work", async () => {
  const { pool, calls, released } = fixture(undefined, true);
  let worked = false;
  await assert.rejects(
    withTenant(pool, a, async () => {
      worked = true;
    }),
    /owner_admission_denied/,
  );
  assert.equal(worked, false);
  assert.equal(calls.at(-1)?.sql, "ROLLBACK");
  assert.deepEqual(released, [1]);
  await closeOwnerDatabase(pool);
});

function deps(pool: Pool, send: (key: string) => Promise<void>): Deps {
  return {
    pool,
    broker: new FakeBroker(),
    metrics: new Metrics(),
    providers: new Semaphore(2),
    policy: testPolicy,
    adapter: () => ({
      send: async (request) => {
        await send(request.idempotencyKey);
        return { kind: "sent", providerRef: "same-id" };
      },
      reconcile: async () => ({ kind: "not_found" }),
    }),
  };
}

test("provider intent commits first and admitted effect/finish retain idempotency on redelivery", async () => {
  const demands: Array<{ fresh?: boolean } | undefined> = [];
  const { pool, calls } = fixture(async (t, demand) => {
    demands.push(demand);
    return route(t);
  });
  const task = makeTask({ tenant_id: a });
  const sent: string[] = [];
  const worker = deps(pool, async (key) => {
    sent.push(key);
    const previous = calls.at(-1)!;
    assert.match(previous.sql, /admit_tenant_placement/);
    assert.ok(
      calls.some((c) => c.sql === "COMMIT" && c.session !== previous.session),
    );
  });
  assert.equal(await handleTask(worker, incoming(task)), "ack");
  assert.equal(await handleTask(worker, incoming(task)), "ack");
  assert.deepEqual(sent, [task.intent_id]);
  assert.ok(demands.some((d) => d?.fresh === true));
  const effectSession = calls.find(
    (c) => c.session === 2 && c.sql.includes("admit_tenant_placement"),
  )!.session;
  assert.ok(
    calls.some(
      (c) => c.session === effectSession && c.sql.includes("FROM deliveries"),
    ),
  );
  assert.equal(
    calls.filter((c) => c.session === effectSession).at(-1)?.sql,
    "COMMIT",
  );
  await closeOwnerDatabase(pool);
});

test("quiesce between committed intent and effect pauses provider and preserves uncertain intent", async () => {
  let resolutions = 0;
  const { pool, calls } = fixture(async (t) => ({
    ...route(t),
    state: ++resolutions === 1 ? "active" : "quiescing",
  }));
  let sent = 0;
  await assert.rejects(
    handleTask(
      deps(pool, async () => {
        sent++;
      }),
      incoming(makeTask({ tenant_id: a })),
    ),
    /tenant_quiescing/,
  );
  assert.equal(sent, 0);
  assert.ok(calls.some((c) => c.sql === "COMMIT"));
  assert.ok(calls.some((c) => c.sql.includes("status = 'in_progress'")));
  await closeOwnerDatabase(pool);
});

test("all shard pools close and hung shutdown is bounded", async () => {
  const { pool, closed } = fixture();
  await closeOwnerDatabase(pool, 100);
  assert.deepEqual(closed.sort(), ["s1", "s2", "s3", "s4"]);
  const hung = fixture(undefined, false, true);
  const before = Date.now();
  await assert.rejects(closeOwnerDatabase(hung.pool, 15), /shutdown_timeout/);
  assert.ok(Date.now() - before < 500);
  assert.equal(hung.closed.length, 4);
});

test("queued provider work waits outside a database transaction while the active effect retains its owner fence", async () => {
  const { pool, calls, released } = fixture();
  let enter!: () => void;
  let complete!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let sends = 0;
  const worker = deps(pool, async () => {
    sends++;
    if (sends === 1) {
      enter();
      await blocked;
    }
  });
  worker.providers = new Semaphore(1);
  worker.policy = { ...testPolicy, providerTimeoutMs: 1000 };
  const first = handleTask(worker, incoming(makeTask({ tenant_id: a })));
  await entered;
  const effect = calls.at(-1)!;
  assert.match(effect.sql, /admit_tenant_placement/);
  assert.equal(released.includes(effect.session), false);
  const second = handleTask(worker, incoming(makeTask({ tenant_id: b })));
  // Wait until the second intent committed and its next continuation queued.
  for (let attempt = 0; attempt < 30; attempt++) {
    if (calls.some((call) => call.session === 3 && call.sql === "COMMIT"))
      break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(calls.some((call) => call.session === 3 && call.sql === "COMMIT"));
  assert.equal(
    new Set(calls.map((call) => call.session)).size,
    3,
    "queued effect must not acquire a fourth session",
  );
  assert.equal(sends, 1);
  assert.equal(worker.providers.inFlight, 1);
  assert.equal(
    calls.some(
      (call) => call.session === effect.session && call.sql === "COMMIT",
    ),
    false,
    "active ownership admission stays pinned until provider effect and finish",
  );
  complete();
  assert.deepEqual(await Promise.all([first, second]), ["ack", "ack"]);
  assert.equal(sends, 2);
  assert.equal(worker.providers.inFlight, 0);
  for (const session of [effect.session, 4]) {
    const statements = calls.filter((call) => call.session === session);
    assert.ok(
      statements.some((call) => call.sql.includes("admit_tenant_placement")),
    );
    assert.ok(
      statements.some((call) =>
        call.sql.includes("UPDATE deliveries SET status = $3"),
      ),
    );
    assert.equal(statements.at(-1)?.sql, "COMMIT");
    assert.equal(released.includes(session), true);
  }
  await closeOwnerDatabase(pool);
});
