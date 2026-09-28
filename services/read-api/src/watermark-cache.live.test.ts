import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type {
  ReadLeaseAuthority,
  ProjectionWatermark,
} from "@greenguard/membership-client";
import { readContext, type ReadContext } from "./consistency.js";
import { createReadRedis } from "./redis.js";
import { EPOCH_KEY, type CacheStore } from "./cache.js";
import {
  GUARD_INIT,
  WATERMARK_METADATA,
  WATERMARK_FILL,
  WATERMARK_HIT,
  watermarkCacheBackends,
  watermarkGuardKey,
} from "./watermark-cache.js";
import type { postgresReads } from "./backends.js";

const liveRedis = () =>
  createReadRedis({
    READ_REDIS_URL: process.env.FRESHNESS_REDIS_URL,
    READ_REDIS_CLUSTER_NODES: process.env.FRESHNESS_REDIS_CLUSTER_NODES,
  })!;
const liveEnabled = Boolean(
  process.env.FRESHNESS_REDIS_URL || process.env.FRESHNESS_REDIS_CLUSTER_NODES,
);

test(
  "real Redis rejects stale fills, missing guards, wrong epochs and expired locks with exact BIGINT comparisons",
  { skip: !liveEnabled },
  async () => {
    const redis = liveRedis();
    await redis.connect();
    const tenantId = randomUUID(),
      incarnation = randomUUID(),
      guard = watermarkGuardKey(tenantId),
      revision = `${guard}:revision`,
      stamp = `${guard}:recovery`,
      lock = `${guard}:test-lock`,
      key = `${guard}:test-entry`;
    const token = (
      sequence: string,
      placementEpoch = "5",
    ): ProjectionWatermark => ({
      v: 1,
      tenantId,
      shardIncarnation: incarnation,
      placementEpoch,
      sequence,
    });
    const encode = (sequence: string, epoch = "5") =>
      JSON.stringify({ watermark: token(sequence, epoch), data: "reading" });
    const evalScript = (script: string, keys: string[], args: string[]) =>
      redis.eval(script, { keys, arguments: args });
    try {
      const initial = JSON.stringify(token("9007199254740993"));
      assert.equal(
        await evalScript(
          GUARD_INIT,
          [guard, stamp, revision],
          [initial, "60000", "1", "0"],
        ),
        1,
      );
      await redis.set(lock, "owner", { PX: 60000 });
      assert.equal(
        await evalScript(
          WATERMARK_FILL,
          [guard, lock, key, stamp, revision],
          ["owner", encode("9007199254740992"), "60000", "1", "0"],
        ),
        0,
      );
      assert.equal(await redis.get(key), null);
      assert.equal(
        await evalScript(
          WATERMARK_FILL,
          [guard, lock, key, stamp, revision],
          ["owner", encode("9007199254740993"), "60000", "1", "0"],
        ),
        1,
      );
      assert.ok(
        await evalScript(
          WATERMARK_HIT,
          [guard, key, stamp, revision],
          [initial, "1", "0"],
        ),
      );
      assert.equal(
        await evalScript(
          WATERMARK_HIT,
          [guard, key, stamp, revision],
          [JSON.stringify(token("9007199254740994")), "1", "0"],
        ),
        null,
      );
      assert.equal(
        await evalScript(
          WATERMARK_HIT,
          [guard, key, stamp, revision],
          [JSON.stringify(token("1", "6")), "1", "0"],
        ),
        null,
      );
      await redis.client.del(guard);
      assert.equal(
        await evalScript(
          WATERMARK_HIT,
          [guard, key, stamp, revision],
          [initial, "1", "0"],
        ),
        null,
      );
      await redis.set(lock, "owner", { PX: 60000 });
      assert.equal(
        await evalScript(
          WATERMARK_FILL,
          [guard, lock, key, stamp, revision],
          ["owner", encode("9223372036854775807"), "60000", "1", "1"],
        ),
        0,
      );
      await redis.client.incr(revision);
      assert.equal(
        await evalScript(
          GUARD_INIT,
          [guard, stamp, revision],
          [initial, "60000", "1", "0"],
        ),
        0,
        "an invalidation between primary snapshot and init must reject that snapshot",
      );
      assert.equal(await redis.get(guard), null);
      assert.equal(
        await evalScript(
          GUARD_INIT,
          [guard, stamp, revision],
          [initial, "60000", "1", "1"],
        ),
        1,
      );
      await redis.client.del(lock);
      assert.equal(
        await evalScript(
          WATERMARK_FILL,
          [guard, lock, key, stamp, revision],
          ["owner", encode("9223372036854775807"), "60000", "1", "1"],
        ),
        0,
      );
    } finally {
      await redis.client.del(guard, revision, stamp, lock, key);
      await redis.close();
    }
  },
);

test(
  "real cache wrapper rebuilds recovery guards from primary, preserves strict minima and fences init races",
  { skip: !liveEnabled },
  async () => {
    const redis = liveRedis();
    await redis.connect();
    const tenantId = randomUUID(),
      incarnation = randomUUID(),
      leaseId = randomUUID();
    const token = (sequence: string): ProjectionWatermark => ({
      v: 1,
      tenantId,
      shardIncarnation: incarnation,
      placementEpoch: "3",
      sequence,
    });
    const guard = watermarkGuardKey(tenantId);
    let origins = 0,
      primary = 0,
      admissions = 0,
      minimumSeen: string | undefined;
    const context = (): ReadContext => ({
      tenantId,
      deadline: Date.now() + 4000,
      lease: {
        leaseId,
        expiresAt: new Date(Date.now() + 5000).toISOString(),
        route: {
          tenantId,
          shardId: "s1",
          shardIncarnation: incarnation,
          placementEpoch: "3",
          state: "active",
          expiresAt: new Date(Date.now() + 1000).toISOString(),
        },
      },
    });
    const authority: ReadLeaseAuthority = {
      acquire: async () => context().lease!,
      admit: async () => {
        admissions++;
      },
      release: async () => {},
    };
    const backend = {
      latest: async () => {
        origins++;
        const ctx = readContext.getStore()!;
        minimumSeen = ctx.minimum?.sequence;
        ctx.watermark = token("10");
        return { value: 10 };
      },
    } as unknown as ReturnType<typeof postgresReads>;
    const commands: string[] = [];
    const counted: CacheStore = {
      get: async (key) => {
        commands.push("get");
        return redis.get(key);
      },
      set: async (key, value, options) => {
        commands.push("set");
        return redis.set(key, value, options);
      },
      eval: async (script, options) => {
        commands.push(
          script === WATERMARK_METADATA
            ? "metadata"
            : script === WATERMARK_HIT
              ? "hit"
              : "eval",
        );
        return redis.eval(script, options);
      },
    };
    const cached = watermarkCacheBackends(backend, counted, {
      authority,
      primaryWatermark: async () => {
        primary++;
        return token("10");
      },
    });
    try {
      // Only this opt-in acceptance suite uses the recovery epoch, in an isolated Redis.
      await redis.set(EPOCH_KEY, "1", { PX: 60000 });
      assert.deepEqual(
        await readContext.run(context(), () =>
          cached.latest(tenantId, "device"),
        ),
        { value: 10 },
      );
      assert.equal(origins, 1);
      assert.equal(primary, 1);
      assert.equal(minimumSeen, "10");
      const beforeHit = admissions;
      commands.length = 0;
      assert.deepEqual(
        await readContext.run(context(), () =>
          cached.latest(tenantId, "device"),
        ),
        { value: 10 },
      );
      assert.equal(origins, 1);
      assert.deepEqual(
        commands,
        ["get", "metadata", "hit", "get"],
        "a guarded warm hit uses four Redis round trips",
      );
      assert.equal(
        admissions,
        beforeHit,
        "cache hit defers response admission to the HTTP boundary instead of doing it twice",
      );
      await redis.set(EPOCH_KEY, "2", { PX: 60000 });
      await readContext.run(context(), () => cached.latest(tenantId, "device"));
      assert.equal(primary, 2);
      assert.equal(origins, 2);
      const strict = context();
      strict.minimum = token("15");
      await readContext.run(strict, () => cached.latest(tenantId, "device"));
      assert.equal(minimumSeen, "15");
      // Redis script must not resurrect the durable snapshot taken before invalidation.
      await redis.client.del(guard);
      const racing = watermarkCacheBackends(backend, redis, {
        authority,
        primaryWatermark: async () => {
          await redis.client.incr(`${guard}:revision`);
          await redis.client.del(guard);
          return token("10");
        },
      });
      await readContext.run(context(), () => racing.latest(tenantId, "device"));
      assert.equal(await redis.get(guard), null);
      const down: CacheStore = {
        get: async () => {
          throw new Error("down");
        },
        set: async () => {
          throw new Error("down");
        },
        eval: async () => {
          throw new Error("down");
        },
      };
      const fallback = watermarkCacheBackends(backend, down, {
        authority,
        primaryWatermark: async () => {
          throw new Error("must not call");
        },
      });
      const demand = context();
      demand.minimum = token("20");
      await readContext.run(demand, () => fallback.latest(tenantId, "device"));
      assert.equal(minimumSeen, "20");
    } finally {
      await redis.close();
    }
  },
);

test(
  "real Redis atomically checks revision, recovery, canonical identities and lock capabilities",
  { skip: !liveEnabled },
  async () => {
    const redis = liveRedis();
    await redis.connect();
    const tenantId = randomUUID(),
      incarnation = randomUUID(),
      guard = watermarkGuardKey(tenantId);
    const stamp = `${guard}:recovery`,
      revision = `${guard}:revision`,
      lock = `${guard}:lock`,
      key = `${guard}:entry`;
    const token: ProjectionWatermark = {
      v: 1,
      tenantId,
      shardIncarnation: incarnation,
      placementEpoch: "9223372036854775807",
      sequence: "9223372036854775807",
    };
    const encoded = JSON.stringify({
      watermark: token,
      data: {
        empty: [],
        nested: [[], null],
        safeInteger: Number.MAX_SAFE_INTEGER,
      },
    });
    const script = (source: string, keys: string[], arguments_: string[]) =>
      redis.eval(source, { keys, arguments: arguments_ });
    const hit = () =>
      script(
        WATERMARK_HIT,
        [guard, key, stamp, revision],
        [JSON.stringify(token), "1", "0"],
      );
    const fill = () =>
      script(
        WATERMARK_FILL,
        [guard, lock, key, stamp, revision],
        ["capability", encoded, "60000", "1", "0"],
      );
    try {
      assert.equal(
        await script(
          GUARD_INIT,
          [guard, stamp, revision],
          [JSON.stringify(token), "60000", "1", "0"],
        ),
        1,
      );
      assert.deepEqual(
        await script(WATERMARK_METADATA, [guard, stamp, revision], []),
        [JSON.stringify(token), "1", "0"],
      );
      await redis.set(lock, "capability", { PX: 60000 });
      assert.equal(await fill(), 1);
      assert.equal(
        await hit(),
        encoded,
        "Lua must preserve the original data JSON, including empty arrays and integer precision",
      );
      await redis.set(lock, "capability", { PX: 60000 });
      await redis.set(stamp, "2", { PX: 60000 });
      assert.equal(await hit(), null);
      assert.equal(await fill(), 0);
      await redis.set(stamp, "1", { PX: 60000 });
      await redis.client.incr(revision);
      assert.equal(await hit(), null);
      assert.equal(await fill(), 0);
      // A different caller cannot consume the lock, even with the correct namespace.
      assert.equal(
        await script(
          WATERMARK_FILL,
          [guard, lock, key, stamp, revision],
          ["intruder", encoded, "60000", "1", "1"],
        ),
        0,
      );
      await redis.set(lock, "capability", { PX: 1 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(
        await script(
          WATERMARK_FILL,
          [guard, lock, key, stamp, revision],
          ["capability", encoded, "60000", "1", "1"],
        ),
        0,
      );
      for (const watermark of [
        { ...token, tenantId: randomUUID() },
        { ...token, shardIncarnation: randomUUID() },
        { ...token, placementEpoch: "1" },
        { ...token, sequence: "9223372036854775808" },
        { ...token, sequence: "01" },
        { ...token, sequence: JSON.parse("9007199254740993") as number },
        { ...token, v: 2 },
        { ...token, extra: "unexpected" },
      ]) {
        await redis.set(
          key,
          JSON.stringify({ watermark, data: "uncertified" }),
          { PX: 60000 },
        );
        assert.equal(
          await script(
            WATERMARK_HIT,
            [guard, key, stamp, revision],
            [JSON.stringify(token), "1", "1"],
          ),
          null,
        );
        await redis.set(lock, "capability", { PX: 60000 });
        assert.equal(
          await script(
            WATERMARK_FILL,
            [guard, lock, key, stamp, revision],
            [
              "capability",
              JSON.stringify({ watermark, data: "uncertified" }),
              "60000",
              "1",
              "1",
            ],
          ),
          0,
        );
      }
      await redis.set(guard, '{"sequence":10}', { PX: 60000 });
      assert.equal(
        await script(
          WATERMARK_HIT,
          [guard, key, stamp, revision],
          [JSON.stringify(token), "1", "1"],
        ),
        null,
      );
      assert.equal(
        await script(
          GUARD_INIT,
          [guard, stamp, revision],
          [JSON.stringify(token), "60000", "1", "1"],
        ),
        1,
        "only the durable primary init may replace malformed metadata",
      );
    } finally {
      await redis.client.del(guard, stamp, revision, lock, key);
      await redis.close();
    }
  },
);

test(
  "real wrapper fences invalidation between metadata and hit and rejects the stale namespace fill",
  { skip: !liveEnabled },
  async () => {
    const redis = liveRedis();
    await redis.connect();
    const tenantId = randomUUID(),
      incarnation = randomUUID(),
      guard = watermarkGuardKey(tenantId);
    const token: ProjectionWatermark = {
      v: 1,
      tenantId,
      shardIncarnation: incarnation,
      placementEpoch: "7",
      sequence: "9007199254740993",
    };
    const context = (): ReadContext => ({
      tenantId,
      deadline: Date.now() + 4000,
      lease: {
        leaseId: randomUUID(),
        expiresAt: new Date(Date.now() + 5000).toISOString(),
        route: {
          tenantId,
          shardId: "s1",
          shardIncarnation: incarnation,
          placementEpoch: "7",
          state: "active",
          expiresAt: new Date(Date.now() + 1000).toISOString(),
        },
      },
    });
    let origins = 0,
      init = 0,
      race = false,
      fillRejected = false;
    const backend = {
      latest: async () => {
        origins++;
        readContext.getStore()!.watermark = token;
        return { origin: true };
      },
    } as unknown as ReturnType<typeof postgresReads>;
    const authority: ReadLeaseAuthority = {
      acquire: async () => context().lease!,
      admit: async () => {},
      release: async () => {},
    };
    const store: CacheStore = {
      get: redis.get,
      set: redis.set,
      eval: async (script, options) => {
        if (script === WATERMARK_HIT && race) {
          race = false;
          await redis.client.incr(`${guard}:revision`);
          await redis.client.del(guard);
        }
        const result = await redis.eval(script, options);
        if (script === WATERMARK_FILL && Number(result) === 0)
          fillRejected = true;
        return result;
      },
    };
    const cached = watermarkCacheBackends(backend, store, {
      authority,
      primaryWatermark: async () => {
        init++;
        return token;
      },
    });
    try {
      await redis.set(EPOCH_KEY, "1", { PX: 60000 });
      await readContext.run(context(), () => cached.latest(tenantId, "device"));
      assert.equal(origins, 1);
      assert.equal(init, 1);
      race = true;
      await readContext.run(context(), () => cached.latest(tenantId, "device"));
      assert.equal(
        origins,
        2,
        "the stale warm entry cannot be served after invalidation",
      );
      assert.equal(
        fillRejected,
        true,
        "the old revision lock cannot fill after invalidation",
      );
      assert.equal(await redis.get(guard), null);
      await readContext.run(context(), () => cached.latest(tenantId, "device"));
      assert.equal(
        init,
        2,
        "the following read rebuilds solely from the owning primary",
      );
    } finally {
      const keys = await redis.client.keys(`gg:read:v2:{t:${tenantId}}:*`);
      if (keys.length) await redis.client.del(...keys);
      await redis.close();
    }
  },
);
