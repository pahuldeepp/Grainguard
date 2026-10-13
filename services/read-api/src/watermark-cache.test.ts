import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type {
  ProjectionWatermark,
  ReadLeaseAuthority,
} from "@greenguard/membership-client";
import type { postgresReads } from "./backends.js";
import { EPOCH_KEY, type CacheStore } from "./cache.js";
import { readContext, type ReadContext } from "./consistency.js";
import { FreshnessUnavailable } from "./replicas.js";
import {
  GUARD_INIT,
  WATERMARK_FILL,
  WATERMARK_HIT,
  WATERMARK_METADATA,
  watermarkCacheBackends,
} from "./watermark-cache.js";

function fixture() {
  const tenantId = randomUUID(),
    incarnation = randomUUID(),
    abort = new AbortController();
  const token = (sequence = "9007199254740993"): ProjectionWatermark => ({
    v: 1,
    tenantId,
    shardIncarnation: incarnation,
    placementEpoch: "9223372036854775807",
    sequence,
  });
  const context: ReadContext = {
    tenantId,
    deadline: Date.now() + 4000,
    signal: abort.signal,
    lease: {
      leaseId: randomUUID(),
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      route: {
        tenantId,
        shardId: "s1",
        shardIncarnation: incarnation,
        placementEpoch: token().placementEpoch,
        state: "active",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      },
    },
  };
  const commands: string[] = [],
    keys: string[][] = [];
  let origins = 0,
    primary = 0,
    admissions = 0,
    minimumSeen: ProjectionWatermark | undefined;
  let onGet: (() => void) | undefined,
    onMetadata: (() => void) | undefined,
    onHit: (() => void) | undefined;
  let onOrigin: (() => void) | undefined,
    onPrimary: (() => void) | undefined,
    onAdmit: (() => void) | undefined;
  let guard: string | null = JSON.stringify(token()),
    stamp = "1",
    revision = "0",
    epoch = "1";
  let hit: string | null = JSON.stringify({
    watermark: token(),
    data: { cached: true },
  });
  const store: CacheStore = {
    get: async (key) => {
      commands.push("get");
      assert.equal(key, EPOCH_KEY);
      onGet?.();
      return epoch;
    },
    set: async () => {
      commands.push("set");
      return "OK";
    },
    eval: async (script, options) => {
      keys.push(options.keys);
      // Scripts can use only explicitly declared keys in one tenant hash slot.
      assert.ok(options.keys.every((key) => key.includes(`{t:${tenantId}}`)));
      if (script === WATERMARK_METADATA) {
        commands.push("metadata");
        onMetadata?.();
        return [guard, stamp, revision];
      }
      if (script === WATERMARK_HIT) {
        commands.push("hit");
        onHit?.();
        return hit;
      }
      if (script === GUARD_INIT) {
        commands.push("init");
        guard = JSON.stringify(token());
        stamp = options.arguments[2];
        return 1;
      }
      if (script === WATERMARK_FILL) {
        commands.push("fill");
        return 1;
      }
      commands.push("unlock");
      return 1;
    },
  };
  const backend = {
    latest: async () => {
      origins++;
      const ctx = readContext.getStore()!;
      minimumSeen = ctx.minimum;
      onOrigin?.();
      ctx.watermark = token();
      return { origin: true };
    },
  } as unknown as ReturnType<typeof postgresReads>;
  const authority: ReadLeaseAuthority = {
    acquire: async () => context.lease!,
    admit: async () => {
      admissions++;
      onAdmit?.();
    },
    release: async () => {},
  };
  const options = {
    authority,
    primaryWatermark: async () => {
      primary++;
      onPrimary?.();
      return token();
    },
    timeoutMs: 10,
  };
  return {
    context,
    abort,
    token,
    commands,
    keys,
    store,
    backend,
    options,
    counts: () => ({ origins, primary, admissions, minimumSeen }),
    setGuard: (value: string | null) => {
      guard = value;
    },
    setHit: (value: string | null) => {
      hit = value;
    },
    setEpoch: (value: string) => {
      epoch = value;
    },
    setStamp: (value: string) => {
      stamp = value;
    },
    setRevision: (value: string) => {
      revision = value;
    },
    hooks: (value: {
      get?: () => void;
      metadata?: () => void;
      hit?: () => void;
      origin?: () => void;
      primary?: () => void;
      admit?: () => void;
    }) => {
      onGet = value.get;
      onMetadata = value.metadata;
      onHit = value.hit;
      onOrigin = value.origin;
      onPrimary = value.primary;
      onAdmit = value.admit;
    },
    run: (cacheStore = store) =>
      readContext.run(context, () =>
        watermarkCacheBackends(backend, cacheStore, options).latest(
          tenantId,
          "device",
        ),
      ),
  };
}

test("warm hit has four Redis commands, exact token and separate global epoch checks", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { cached: true });
  assert.deepEqual(f.commands, ["get", "metadata", "hit", "get"]);
  assert.deepEqual(f.context.watermark, f.token());
  assert.deepEqual(f.counts(), {
    origins: 0,
    primary: 0,
    admissions: 0,
    minimumSeen: undefined,
  });
  assert.equal(f.keys[1].length, 4);
});

test("primary guard initialization and newer retained guard set the origin floor", async () => {
  const f = fixture();
  f.setGuard(null);
  f.setHit(null);
  assert.deepEqual(await f.run(), { origin: true });
  assert.equal(f.counts().primary, 1);
  assert.equal(f.counts().admissions, 2);
  assert.deepEqual(f.counts().minimumSeen, f.token());
  assert.ok(f.commands.includes("fill"));
  assert.equal(f.context.minimum, undefined);
  const newer = fixture();
  newer.setStamp("0");
  newer.setHit(null);
  const high = newer.token("9007199254740994");
  const store: CacheStore = {
    ...newer.store,
    eval: async (script, options) => {
      const result = await newer.store.eval(script, options);
      if (script === GUARD_INIT) newer.setGuard(JSON.stringify(high));
      return result;
    },
  };
  await newer.run(store);
  assert.deepEqual(newer.counts().minimumSeen, high);
  assert.ok(
    !newer.commands.includes("fill"),
    "an origin below the retained guard cannot fill",
  );
});

test("cache outage, timeout and changed recovery epoch preserve the requested origin minimum", async () => {
  for (const failure of ["outage", "timeout", "recovery"] as const) {
    const f = fixture();
    f.context.minimum = f.token("9223372036854775807");
    const store: CacheStore =
      failure === "outage"
        ? {
            get: async () => {
              throw new Error("down");
            },
            set: f.store.set,
            eval: f.store.eval,
          }
        : failure === "timeout"
          ? { ...f.store, eval: async () => new Promise(() => {}) }
          : f.store;
    if (failure === "recovery") f.hooks({ hit: () => f.setEpoch("2") });
    await f.run(store);
    assert.deepEqual(f.counts().minimumSeen, f.context.minimum);
    assert.equal(f.counts().origins, 1);
    assert.equal(f.counts().primary, 0);
  }
});

test("malformed metadata and wrong-identity cache envelopes fall back without certifying", async () => {
  for (const corrupt of [
    "revision",
    "guard",
    "tenant",
    "incarnation",
    "sequence",
  ] as const) {
    const f = fixture();
    if (corrupt === "revision") f.setRevision("00");
    else if (corrupt === "guard") f.setGuard('{"sequence":10}');
    else {
      const watermark = {
        ...f.token(),
        ...(corrupt === "tenant"
          ? { tenantId: randomUUID() }
          : corrupt === "incarnation"
            ? { shardIncarnation: randomUUID() }
            : { sequence: "9007199254740992" }),
      };
      f.setHit(JSON.stringify({ watermark, data: "leak" }));
    }
    assert.deepEqual(await f.run(), { origin: true });
    assert.equal(f.counts().origins, 1);
  }
});

test("abort or expiry cannot start Redis or origin work", async () => {
  for (const expired of [false, true]) {
    const f = fixture();
    if (expired) f.context.deadline = Date.now() - 1;
    else f.abort.abort();
    await assert.rejects(f.run(), FreshnessUnavailable);
    assert.deepEqual(f.commands, []);
    assert.equal(f.counts().origins, 0);
  }
});

test("abort during metadata, hit or primary lookup cannot admit, certify or fall back", async () => {
  for (const stage of ["metadata", "hit", "primary", "admit"] as const) {
    const f = fixture();
    if (stage === "primary" || stage === "admit") f.setGuard(null);
    f.hooks({ [stage]: () => f.abort.abort() });
    await assert.rejects(f.run(), FreshnessUnavailable);
    assert.equal(f.counts().origins, 0);
    assert.equal(f.context.watermark, undefined);
    assert.ok(!f.commands.includes("init"));
    assert.ok(!f.commands.includes("fill"));
    assert.equal(f.counts().admissions, stage === "admit" ? 1 : 0);
  }
});

test("abort during origin or fill admission stops effects and restores the request minimum", async () => {
  for (const stage of ["origin", "admit"] as const) {
    const f = fixture();
    f.setHit(null);
    f.hooks({ [stage]: () => f.abort.abort() });
    await assert.rejects(f.run(), FreshnessUnavailable);
    assert.equal(f.counts().origins, 1);
    assert.equal(f.context.minimum, undefined);
    assert.ok(!f.commands.includes("fill"));
    assert.ok(!f.commands.includes("unlock"));
    assert.equal(f.counts().admissions, stage === "admit" ? 1 : 0);
  }
});

test("parallel misses isolate origin minima and fill using each load's own watermark", async () => {
  const f = fixture();
  f.setHit(null);
  const children: ReadContext[] = [],
    fills: string[] = [];
  let metadataReads = 0,
    arrivals = 0;
  let release!: () => void;
  const bothOrigins = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store: CacheStore = {
    ...f.store,
    eval: async (script, options) => {
      if (script === WATERMARK_METADATA) {
        metadataReads++;
        return [
          JSON.stringify(f.token(metadataReads === 1 ? "10" : "20")),
          "1",
          "0",
        ];
      }
      if (script === WATERMARK_FILL)
        fills.push(
          (
            JSON.parse(options.arguments[1]) as {
              watermark: ProjectionWatermark;
            }
          ).watermark.sequence,
        );
      return f.store.eval(script, options);
    },
  };
  const backend = {
    latest: async () => {
      const ctx = readContext.getStore()!;
      children.push(ctx);
      const floor = ctx.minimum!;
      arrivals++;
      if (arrivals === 2) release();
      await bothOrigins;
      assert.deepEqual(
        ctx.minimum,
        floor,
        "a sibling cannot overwrite an origin's floor",
      );
      assert.equal(
        f.context.minimum,
        undefined,
        "the parent minimum remains immutable",
      );
      ctx.watermark = {
        ...floor,
        sequence: (BigInt(floor.sequence) + 1n).toString(),
      };
      return { floor: floor.sequence };
    },
  } as unknown as ReturnType<typeof postgresReads>;
  const cached = watermarkCacheBackends(backend, store, f.options);
  const results = await readContext.run(f.context, () =>
    Promise.all([
      cached.latest(f.context.tenantId, "a"),
      cached.latest(f.context.tenantId, "b"),
    ]),
  );
  assert.deepEqual(results, [{ floor: "10" }, { floor: "20" }]);
  assert.notEqual(children[0], children[1]);
  assert.notEqual(children[0], f.context);
  assert.deepEqual(
    fills.sort(),
    ["11", "21"],
    "the parent's older aggregate proof cannot replace a sibling's fill proof",
  );
  assert.equal(f.context.watermark?.sequence, "11");
  assert.equal(f.context.minimum, undefined);
});

for (const stage of ["initialization", "fill"] as const) {
  test(`disconnect during pending ${stage} admission rejects without subsequent cache effects`, async () => {
    const f = fixture();
    if (stage === "initialization") f.setGuard(null);
    else f.setHit(null);
    let started!: () => void;
    const admissionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.options.authority.admit = async (lease, options) => {
      assert.equal(lease, f.context.lease);
      assert.equal(options?.deadline, f.context.deadline);
      assert.equal(options?.signal, f.abort.signal);
      started();
      await new Promise<void>(() => {});
    };
    const pending = f.run();
    const rejected = assert.rejects(pending, FreshnessUnavailable);
    await admissionStarted;
    const commandsBeforeAbort = [...f.commands];
    f.abort.abort();
    await rejected;
    assert.deepEqual(f.commands, commandsBeforeAbort);
    assert.ok(!f.commands.includes("init"));
    assert.ok(!f.commands.includes("fill"));
    assert.ok(!f.commands.includes("unlock"));
    assert.equal(f.counts().origins, stage === "initialization" ? 0 : 1);
  });
}
