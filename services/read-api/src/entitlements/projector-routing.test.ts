import assert from "node:assert/strict";
import { test } from "node:test";
import type pg from "pg";
import type { Envelope } from "@greenguard/entitlements";
import type { TenantRoute } from "@greenguard/membership-client";
import {
  applyEntitlement,
  applyHeartbeat,
  closeProjectorPool,
  createProjectorPool,
  startProjector,
} from "./projector.js";

const tenant = "10000000-0000-4000-8000-000000000001";
const incarnation = "20000000-0000-4000-8000-000000000001";
const event = {
  tenant_id: tenant,
  payload: {
    plan_key: "pro",
    plan_version: "1",
    limits: {},
    features: {},
    source_version: "1",
  },
} as Envelope;

function fixture(
  options: {
    state?: TenantRoute["state"];
    admissionError?: boolean;
    mismatch?: boolean;
    wrongRole?: boolean;
    heartbeatWrite?: () => Promise<void>;
  } = {},
) {
  const calls = new Map<string, Array<{ sql: string; params?: unknown[] }>>();
  const closes: string[] = [];
  const releases: string[] = [];
  const connects: string[] = [];
  const manifest = {
    formatVersion: 1,
    service: "read-api",
    database: "greenguard_read",
    shards: {} as Record<string, unknown>,
  };
  for (const id of ["s1", "s2", "s3", "s4"]) {
    const url = `postgresql://${options.wrongRole ? "read_query" : "read_entitlement_projector"}:fixture@${id}.primary.example:5432/greenguard_read?sslmode=verify-full&sslrootcert=/ca.pem`;
    manifest.shards[id] = { incarnation, primaryUrl: url, replicaUrls: [] };
    calls.set(id, []);
  }
  const pool = createProjectorPool(
    { SHARD_REGISTRY_FILE: "private" },
    {
      readRegistry: () => JSON.stringify(manifest),
      resolve: async (id) => ({
        tenantId: id,
        shardId: "s3",
        shardIncarnation: options.mismatch ? tenant : incarnation,
        placementEpoch: "7",
        state: options.state ?? "active",
        expiresAt: new Date(Date.now() + 1500).toISOString(),
      }),
      create: (_url, id) => {
        const query = async (sql: string, params?: unknown[]) => {
          calls.get(id!)!.push({ sql, params });
          if (options.admissionError && sql.includes("admit_tenant_placement"))
            throw new Error("fixture owner moved");
          if (sql.includes("INSERT INTO read.entitlement_feed_health"))
            await options.heartbeatWrite?.();
          return { rowCount: 1 };
        };
        return {
          connect: async () => {
            connects.push(id!);
            return { query, release: () => releases.push(id!) };
          },
          query,
          end: async () => {
            closes.push(id!);
          },
        } as unknown as pg.Pool;
      },
    },
  );
  return { pool, calls, closes, connects, releases };
}

test("entitlement resolves one tenant owner and admits full placement before SQL", async () => {
  const f = fixture();
  assert.equal(await applyEntitlement(f.pool, event), true);
  assert.deepEqual(f.connects, ["s3"]);
  const queries = f.calls.get("s3")!;
  assert.equal(queries[0].sql, "BEGIN");
  assert.match(queries[1].sql, /app.shard_incarnation/);
  assert.deepEqual(queries[1].params, [tenant, "s3", incarnation, "7"]);
  assert.match(queries[2].sql, /admit_tenant_placement/);
  assert.match(queries[3].sql, /INSERT INTO read.tenant_entitlements/);
  assert.equal(queries.at(-1)?.sql, "COMMIT");
  assert.deepEqual(f.releases, ["s3"]);
  await closeProjectorPool(f.pool);
  assert.deepEqual(f.closes.sort(), ["s1", "s2", "s3", "s4"]);
});

test("moved owner rolls back and releases before business SQL", async () => {
  const f = fixture({ admissionError: true });
  await assert.rejects(
    applyEntitlement(f.pool, event),
    /owner_admission_denied/,
  );
  assert.equal(f.calls.get("s3")!.at(-1)?.sql, "ROLLBACK");
  assert.ok(f.calls.get("s3")!.every(({ sql }) => !sql.includes("INSERT")));
  assert.deepEqual(f.releases, ["s3"]);
  await closeProjectorPool(f.pool);
});

test("quiescing and incarnation mismatch refuse to allocate a tenant transaction", async () => {
  for (const options of [{ state: "quiescing" as const }, { mismatch: true }]) {
    const f = fixture(options);
    await assert.rejects(applyEntitlement(f.pool, event));
    assert.deepEqual(f.connects, []);
    await closeProjectorPool(f.pool);
  }
});

test("heartbeat fans out partition-only monotonic health to all physical pools", async () => {
  const f = fixture();
  const at = new Date();
  await applyHeartbeat(f.pool, 3, at);
  for (const queries of f.calls.values()) {
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /GREATEST/);
    assert.deepEqual(queries[0].params, [3, at]);
    assert.ok(!queries[0].sql.includes("tenant_entitlements"));
  }
  await closeProjectorPool(f.pool);
});

test("main read query credentials cannot instantiate entitlement writer registry", () => {
  assert.throws(() => fixture({ wrongRole: true }), /invalid_owner_endpoint/);
});

test("startup failure closes every private pool and shutdown is idempotent", async () => {
  const failed = fixture();
  await assert.rejects(
    startProjector(failed.pool, ["fixture"], async () => {
      throw new Error("fixture startup failure");
    }),
    /startup failure/,
  );
  assert.deepEqual(failed.closes.sort(), ["s1", "s2", "s3", "s4"]);
  const running = fixture();
  let stopped = 0;
  const close = await startProjector(
    running.pool,
    ["fixture"],
    async () => async () => {
      stopped++;
    },
  );
  await Promise.all([close(), close()]);
  assert.equal(stopped, 1);
  assert.deepEqual(running.closes.sort(), ["s1", "s2", "s3", "s4"]);
});

test("fatal consumer error stops worker and closes all pools before exit", async (t) => {
  const f = fixture();
  let fatal: ((error: Error) => void) | undefined;
  let stopped = false;
  let notifyExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    notifyExit = resolve;
  });
  t.mock.method(console, "error", () => undefined);
  t.mock.method(process, "exit", (code: number) => {
    assert.equal(code, 1);
    assert.ok(stopped);
    assert.deepEqual(f.closes.sort(), ["s1", "s2", "s3", "s4"]);
    notifyExit();
    return undefined as never;
  });
  const close = await startProjector(f.pool, ["fixture"], async (options) => {
    fatal = options.onFatal;
    return async () => {
      stopped = true;
    };
  });
  fatal!(new Error("fixture-only fatal payload"));
  await exited;
  await close();
});

test("heartbeat writes are bounded to two and failures propagate", async () => {
  let active = 0;
  let maximum = 0;
  const pending: Array<() => void> = [];
  const f = fixture({
    heartbeatWrite: () =>
      new Promise<void>((resolve) => {
        active++;
        maximum = Math.max(maximum, active);
        pending.push(() => {
          active--;
          resolve();
        });
      }),
  });
  const work = applyHeartbeat(f.pool, 0, new Date());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending.splice(0).forEach((resolve) => resolve());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending.splice(0).forEach((resolve) => resolve());
  await work;
  assert.equal(maximum, 2);
  await closeProjectorPool(f.pool);
  const failed = fixture({
    heartbeatWrite: async () => {
      throw new Error("fixture heartbeat failed");
    },
  });
  await assert.rejects(
    applyHeartbeat(failed.pool, 0, new Date()),
    /heartbeat failed/,
  );
  assert.equal(failed.calls.get("s3")!.length, 0);
  assert.equal(failed.calls.get("s4")!.length, 0);
  await closeProjectorPool(failed.pool);
});
