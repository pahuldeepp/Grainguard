import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admitOwnerPlacement,
  closeOwnerDatabase,
  createOwnerDatabase,
  ownerDatabases,
  parseOwnerRegistry,
  requireShardRegistry,
  resolveOwnerDatabase,
} from "./owner-db.js";
import type { TenantRoute } from "./placement.js";

const a = "10000000-0000-4000-8000-000000000001";
const b = "10000000-0000-4000-8000-000000000002";
const incarnation = "20000000-0000-4000-8000-000000000001";
function manifest() {
  return {
    formatVersion: 1,
    service: "test-service",
    database: "greenguard_test",
    shards: Object.fromEntries(
      [1, 2, 3, 4].map((n) => [
        `s${n}`,
        {
          incarnation,
          primaryUrl: `postgresql://test_app:secret@localhost:${6000 + n}/greenguard_test`,
          replicaUrls: [],
        },
      ]),
    ),
  };
}
function route(tenantId: string, shardId = "s1"): TenantRoute {
  return {
    tenantId,
    shardId,
    shardIncarnation: incarnation,
    placementEpoch: "12",
    state: "active",
    expiresAt: new Date(Date.now() + 1900).toISOString(),
  };
}
const config = {
  service: "test-service",
  database: "greenguard_test",
  roles: ["test_app"],
  allowLoopback: true,
};
function runtime(
  resolve: (tenant: string) => Promise<TenantRoute>,
  close: (db: { shard?: string }) => Promise<unknown> = async () => {},
) {
  return createOwnerDatabase({
    legacyUrl: "must-not-fallback",
    env: { SHARD_REGISTRY_FILE: "private", SHARD_LOCAL_LOOPBACK: "true" },
    ...config,
    readRegistry: () => JSON.stringify(manifest()),
    create: (_url, shard) => ({ shard }),
    resolve,
    close,
  });
}

test("registry validates all four owner roles/database/TLS endpoints before allocation", () => {
  assert.equal(
    parseOwnerRegistry(JSON.stringify(manifest()), config).length,
    4,
  );
  for (const mutate of [
    (m: ReturnType<typeof manifest>) => {
      m.service = "other";
    },
    (m: ReturnType<typeof manifest>) => {
      delete m.shards.s4;
    },
    (m: ReturnType<typeof manifest>) => {
      m.shards.s4.primaryUrl =
        "postgresql://postgres:secret@localhost:6004/greenguard_test";
    },
    (m: ReturnType<typeof manifest>) => {
      m.shards.s4.primaryUrl = m.shards.s1.primaryUrl;
    },
    (m: ReturnType<typeof manifest>) => {
      m.shards.s4.incarnation = "bad";
    },
    (m: ReturnType<typeof manifest>) => {
      m.shards.s4.primaryUrl += "?user=postgres";
    },
    (m: ReturnType<typeof manifest>) => {
      m.shards.s4.primaryUrl += "?sslmode=verify-full&sslmode=disable";
    },
    (m: ReturnType<typeof manifest>) => {
      m.shards.s4.primaryUrl = m.shards.s1.primaryUrl.replace(
        "secret",
        "different-password",
      );
    },
  ]) {
    const data = manifest();
    mutate(data);
    let allocated = 0;
    assert.throws(() =>
      createOwnerDatabase({
        ...config,
        legacyUrl: "legacy",
        env: { SHARD_REGISTRY_FILE: "x", SHARD_LOCAL_LOOPBACK: "true" },
        readRegistry: () => JSON.stringify(data),
        create: () => {
          allocated++;
          return {};
        },
        close: async () => {},
        resolve: async (t) => route(t),
      }),
    );
    assert.equal(allocated, 0);
  }
  assert.throws(
    () =>
      parseOwnerRegistry(JSON.stringify(manifest()), {
        ...config,
        allowLoopback: false,
      }),
    /invalid_owner_endpoint/,
  );
});

test("shard-required runtime rejects a missing registry instead of using the legacy URL", () => {
  let allocated = 0;
  assert.throws(
    () =>
      createOwnerDatabase({
        ...config,
        legacyUrl: "legacy-central-database",
        env: { SHARD_ROUTING_REQUIRED: "true" },
        create: () => {
          allocated++;
          return {};
        },
        close: async () => {},
      }),
    /shard_registry_required/,
  );
  assert.equal(allocated, 0);
  assert.throws(
    () =>
      requireShardRegistry(
        { SHARD_ROUTING_REQUIRED: "true", READ_SHARD_REGISTRY_FILE: " " },
        "READ_SHARD_REGISTRY_FILE",
      ),
    /shard_registry_required/,
  );
});

test("legacy database selection is retained only when shard routing is not required", () => {
  for (const env of [{}, { SHARD_ROUTING_REQUIRED: "false" }]) {
    let selected = "";
    const db = createOwnerDatabase({
      ...config,
      legacyUrl: "legacy-central-database",
      env,
      create: (url) => {
        selected = url;
        return {};
      },
      close: async () => {},
    });
    assert.equal(selected, "legacy-central-database");
    void db;
  }
  assert.throws(
    () =>
      createOwnerDatabase({
        ...config,
        legacyUrl: "legacy-central-database",
        env: { SHARD_ROUTING_REQUIRED: "yes" },
        create: () => ({}),
        close: async () => {},
      }),
    /invalid_shard_routing_required/,
  );
});

test("tenant requests select private pools independently with no default or client route fallback", async () => {
  const db = runtime(async (tenant) =>
    route(tenant, tenant === a ? "s1" : "s4"),
  );
  const [first, second] = await Promise.all([
    resolveOwnerDatabase(db, a),
    resolveOwnerDatabase(db, b),
  ]);
  assert.equal(first.database.shard, "s1");
  assert.equal(second.database.shard, "s4");
  assert.equal(ownerDatabases(db).length, 4);
  assert.throws(() => db.shard, /owner_tenant_required/);
  assert.equal(
    (await resolveOwnerDatabase(first.database, b)).database.shard,
    "s4",
  );
  await closeOwnerDatabase(db);
  await assert.rejects(resolveOwnerDatabase(db, a), /owner_database_closing/);
});

test("missing, cross-tenant, expired, wrong incarnation and quiescing authority never downgrade", async () => {
  for (const resolve of [
    async () => {
      throw new Error("authority down");
    },
    async () => route(b),
    async () => ({
      ...route(a),
      expiresAt: new Date(Date.now() - 1).toISOString(),
    }),
    async () => ({ ...route(a), shardIncarnation: b }),
    async () => ({ ...route(a), state: "quiescing" as const }),
    async () => route(a, "outside"),
  ]) {
    const db = runtime(resolve);
    await assert.rejects(resolveOwnerDatabase(db, a));
    await closeOwnerDatabase(db);
  }
});

test("exact placement context and durable admission precede business work", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const accepted = route(a);
  await admitOwnerPlacement(a, accepted, async (sql, params) => {
    calls.push({ sql, params });
  });
  assert.match(
    calls[0].sql,
    /set_config\('app.tenant_id'.*app.shard_id.*app.shard_incarnation.*app.placement_epoch/,
  );
  assert.match(calls[1].sql, /admit_tenant_placement/);
  assert.deepEqual(calls[1].params, [a, "s1", incarnation, "12"]);
  await assert.rejects(
    admitOwnerPlacement(b, accepted, async () => {}),
    /invalid_placement_response/,
  );
  await assert.rejects(
    admitOwnerPlacement(a, accepted, async (sql) => {
      if (sql.includes("admit_tenant")) throw new Error("stale epoch");
    }),
    /owner_admission_denied/,
  );
});

test("shutdown invokes every pool once, reports failures and bounds hung closure", async () => {
  const closed: string[] = [];
  const db = runtime(
    async (t) => route(t),
    async (client) => {
      closed.push(client.shard!);
      if (client.shard === "s2") throw new Error("close failed");
    },
  );
  await assert.rejects(
    closeOwnerDatabase(db, 100),
    /owner_database_shutdown_failed/,
  );
  assert.deepEqual(closed.sort(), ["s1", "s2", "s3", "s4"]);
  await assert.rejects(
    closeOwnerDatabase(db, 100),
    /owner_database_shutdown_failed/,
  );
  assert.equal(closed.length, 4);
  const hung = runtime(
    async (t) => route(t),
    () => new Promise(() => {}),
  );
  const before = Date.now();
  await assert.rejects(
    closeOwnerDatabase(hung, 15),
    /owner_database_shutdown_timeout/,
  );
  assert.ok(Date.now() - before < 500);
});

test("failed construction closes earlier databases and preserves its original error", async () => {
  const failure = new Error("third database creation failed");
  const created: Array<{ shard: string }> = [],
    closed: string[] = [];
  assert.throws(
    () =>
      createOwnerDatabase({
        ...config,
        legacyUrl: "unused",
        env: { SHARD_REGISTRY_FILE: "private", SHARD_LOCAL_LOOPBACK: "true" },
        readRegistry: () => JSON.stringify(manifest()),
        resolve: async (tenant) => route(tenant),
        create: (_url, shard) => {
          if (shard === "s3") throw failure;
          const database = { shard: shard! };
          created.push(database);
          return database;
        },
        close: (database) => {
          closed.push(database.shard);
          if (database.shard === "s1") throw new Error("sync close failed");
          return Promise.reject(new Error("async close failed"));
        },
      }),
    (error) => error === failure,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(closed, ["s1", "s2"]);
  assert.equal(created.length, 2);
  for (const database of created)
    assert.deepEqual(await resolveOwnerDatabase(database, a), { database });
});
