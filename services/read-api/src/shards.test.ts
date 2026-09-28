import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import {
  createShardReadRegistry,
  contextualReplicaProvider,
  type ShardReadRegistry,
} from "./shards.js";
import { readContext, type ReadContext } from "./consistency.js";
import {
  FreshnessUnavailable,
  type ReplicaProvider,
  type ReplicaRequest,
} from "./replicas.js";
const tenantId = "11111111-1111-4111-8111-111111111111",
  incarnation = "22222222-2222-4222-8222-222222222222";

test("invalid shard pool capacity fails before allocating connections", () => {
  for (const poolMax of [0, -1, 1.5, NaN, 33]) {
    assert.throws(
      () => createShardReadRegistry("{}", { poolMax }),
      /invalid_read_shard_pool_max/,
    );
  }
});
function context(shardId = "s2", minimum = "10"): ReadContext {
  return {
    tenantId,
    deadline: Date.now() + 4000,
    minimum: {
      v: 1,
      tenantId,
      shardIncarnation: incarnation,
      placementEpoch: "5",
      sequence: minimum,
    },
    lease: {
      leaseId: incarnation,
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      route: {
        tenantId,
        shardId,
        shardIncarnation: incarnation,
        placementEpoch: "5",
        state: "active",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      },
    },
  };
}
test("registry validates all four private bundles before allocating pools and limits credentials to read_query", () => {
  const config = {
    formatVersion: 1,
    service: "read-api",
    database: "greenguard_read",
    shards: Object.fromEntries(
      ["s1", "s2", "s3", "s4"].map((id) => [
        id,
        {
          incarnation,
          primaryUrl: `postgres://read_query:secret@${id}/greenguard_read?sslmode=verify-full&sslrootcert=/ca.pem`,
          replicaUrls: [],
        },
      ]),
    ),
  };
  let allocations = 0;
  const factory = () => {
    allocations++;
    return {
      on: () => {},
      end: async () => {},
      connect: async () =>
        ({
          query: async () => ({ rows: [] }),
          release: () => {},
        }) as unknown as PoolClient,
    } as unknown as Pool;
  };
  const invalid = structuredClone(config);
  delete invalid.shards.s4;
  assert.throws(() =>
    createShardReadRegistry(JSON.stringify(invalid), { poolFactory: factory }),
  );
  assert.equal(allocations, 0);
  const unsafe = structuredClone(config);
  unsafe.shards.s4.primaryUrl = unsafe.shards.s4.primaryUrl.replace(
    "read_query",
    "postgres",
  );
  assert.throws(() =>
    createShardReadRegistry(JSON.stringify(unsafe), { poolFactory: factory }),
  );
  assert.equal(allocations, 0);
  const duplicate = structuredClone(config);
  duplicate.shards.s4.primaryUrl = duplicate.shards.s1.primaryUrl;
  assert.throws(() =>
    createShardReadRegistry(JSON.stringify(duplicate), {
      poolFactory: factory,
    }),
  );
  assert.equal(allocations, 0);
  for (const suffix of [
    "&sslmode=disable",
    "&host=another-database",
    "&options=-c%20role=postgres",
    "#untrusted",
  ]) {
    const override = structuredClone(config);
    override.shards.s4.primaryUrl += suffix;
    assert.throws(() =>
      createShardReadRegistry(JSON.stringify(override), {
        poolFactory: factory,
      }),
    );
    assert.equal(allocations, 0);
  }
  duplicate.shards.s4.primaryUrl = duplicate.shards.s1.primaryUrl.replace(
    "secret",
    "other-password",
  );
  assert.throws(() =>
    createShardReadRegistry(JSON.stringify(duplicate), {
      poolFactory: factory,
    }),
  );
  assert.equal(allocations, 0);
  const registry = createShardReadRegistry(JSON.stringify(config), {
    poolFactory: factory,
  });
  assert.equal(allocations, 4);
  assert.equal(registry.providers.size, 4);
  void registry.close();
});
test("trusted lease selects only its shard; missing, foreign and stale config fail before pool access", async () => {
  const calls: string[] = [];
  const fake = (shard: string): ReplicaProvider => ({
    acquire: async (request: ReplicaRequest) => {
      calls.push(shard);
      assert.equal(request.minimumSequence?.sequence, "10");
      assert.equal(request.placement?.shardId, shard);
      return {
        endpoint: shard,
        tx: { query: async () => ({ rows: [] }) } as unknown as PoolClient,
        watermark: {
          shardIncarnation: incarnation,
          placementEpoch: "5",
          sequence: "11",
        },
        commit: async () => {},
        rollback: async () => {},
      };
    },
    withTenant: async () => {
      throw new Error("must not bypass admission");
    },
    health: async () => [],
    ready: async () => {},
    close: async () => {},
  });
  const registry: ShardReadRegistry = {
    providers: new Map([
      ["s1", fake("s1")],
      ["s2", fake("s2")],
    ]),
    incarnations: new Map([
      ["s1", incarnation],
      ["s2", incarnation],
    ]),
    primary: () => {
      throw new Error();
    },
    ready: async () => {},
    close: async () => {},
  };
  const provider = contextualReplicaProvider(registry);
  await assert.rejects(
    provider.withTenant(tenantId, async () => "bad"),
    FreshnessUnavailable,
  );
  const ctx = context();
  assert.equal(
    await readContext.run(ctx, () =>
      provider.withTenant(tenantId, async () => "data"),
    ),
    "data",
  );
  assert.equal(ctx.watermark?.sequence, "11");
  await assert.rejects(
    readContext.run(context("s4"), () =>
      provider.withTenant(tenantId, async () => "bad"),
    ),
    FreshnessUnavailable,
  );
  const mismatched = context();
  mismatched.lease!.route.shardIncarnation = tenantId;
  await assert.rejects(
    readContext.run(mismatched, () =>
      provider.withTenant(tenantId, async () => "bad"),
    ),
    FreshnessUnavailable,
  );
  await assert.rejects(
    readContext.run(context(), () =>
      provider.withTenant(incarnation, async () => "bad"),
    ),
    FreshnessUnavailable,
  );
  assert.deepEqual(calls, ["s2"]);
});

test("internal metadata snapshots do not certify application rows and retain cancellation", async () => {
  const ctx = context();
  const controller = new AbortController();
  ctx.signal = controller.signal;
  let calls = 0;
  const source = {
    acquire: async (request: ReplicaRequest) => {
      calls++;
      assert.equal(request.signal, controller.signal);
      assert.equal(request.primaryOnly, true);
      return {
        endpoint: "primary",
        tx: {} as PoolClient,
        watermark: {
          shardIncarnation: incarnation,
          placementEpoch: "5",
          sequence: "99",
        },
        commit: async () => {},
        rollback: async () => {},
      };
    },
    ready: async () => {},
    close: async () => {},
    health: async () => [],
  } as unknown as ReplicaProvider;
  const provider = contextualReplicaProvider(source);
  await readContext.run(ctx, async () => {
    const snapshot = await provider.acquire({
      tenantId,
      deadline: ctx.deadline,
      primaryOnly: true,
      certify: false,
    });
    await snapshot.commit();
    assert.equal(ctx.watermark, undefined);
    controller.abort();
    await assert.rejects(
      provider.acquire({ tenantId, deadline: ctx.deadline }),
      FreshnessUnavailable,
    );
  });
  assert.equal(calls, 1);
});

test("configured shard pool capacity applies to primary pools without connecting", async () => {
  const config = {
    formatVersion: 1,
    service: "read-api",
    database: "greenguard_read",
    shards: Object.fromEntries(
      ["s1", "s2", "s3", "s4"].map((id) => [
        id,
        {
          incarnation,
          primaryUrl: `postgres://read_query:secret@${id}/greenguard_read?sslmode=verify-full&sslrootcert=/ca.pem`,
          replicaUrls: [],
        },
      ]),
    ),
  };
  for (const poolMax of [1, 12, 32]) {
    const registry = createShardReadRegistry(JSON.stringify(config), {
      poolMax,
    });
    try {
      const primary = readContext.run(context(), () =>
        registry.primary(tenantId),
      ) as Pool;
      assert.equal(primary.options.max, poolMax);
      assert.equal(primary.totalCount, 0);
    } finally {
      await registry.close();
    }
  }
});
