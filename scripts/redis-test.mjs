#!/usr/bin/env node
// Live Redis Cluster checks for the Read API cache (ADR-0015). Opt-in: `make redis-test`.
// Requires `make redis-up` and a built read-api (`npm run build -w @greenguard/read-api`).
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { ReadCache } from "../services/read-api/dist/cache.js";
import { createReadRedis } from "../services/read-api/dist/redis.js";
import { composeContainerName } from "./ci-compose-project.mjs";

const PROJECT = process.env.COMPOSE_PROJECT_NAME || "greenguard-redis";
const COMPOSE_FILE = "infra/redis/compose.yaml";
const NODES = [1, 2, 3, 4, 5, 6];
const env = {
  READ_REDIS_CLUSTER_NODES: NODES.map((n) => `redis://127.0.0.1:710${n}`).join(
    ",",
  ),
  READ_REDIS_NODE_ADDRESS_MAP: NODES.map(
    (n) => `redis-node-${n}:6379=127.0.0.1:710${n}`,
  ).join(","),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const container = (n) =>
  composeContainerName(`redis-node-${n}`, {
    COMPOSE_PROJECT_NAME: PROJECT,
  });
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
// Disruptions run asynchronously so they never block the event loop being measured.
const dockerAsync = (...args) => promisify(execFile)("docker", args);
const cli = (n, ...args) =>
  docker("exec", container(n), "redis-cli", ...args).trim();

function record(name, pass, detail) {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
}

function clusterOk() {
  for (const n of NODES) {
    try {
      if (cli(n, "cluster", "info").includes("cluster_state:ok")) return true;
    } catch {
      // Node may be down; ask the next one.
    }
  }
  return false;
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(250);
  }
  return false;
}

// Every node must see 6 connected peers, 3 slot-owning primaries and no stale addresses.
function healthyTopology() {
  try {
    return NODES.every((n) => {
      const lines = cli(n, "cluster", "nodes").split("\n");
      const bad = lines.some((l) =>
        /fail|noaddr|disconnected|handshake/.test(l),
      );
      const primaries = lines.filter(
        (l) => l.includes("master") && /\d+-\d+/.test(l),
      );
      return lines.length === 6 && !bad && primaries.length === 3;
    });
  } catch {
    return false;
  }
}

function primaryOf(n) {
  return cli(n, "role").split("\n")[0] === "master";
}

function counter(value = "v", delayMs = 0) {
  const origin = { loads: 0, value };
  origin.load = async () => {
    origin.loads++;
    if (delayMs) await sleep(delayMs);
    return origin.value;
  };
  return origin;
}

async function isolation(redis) {
  const cache = new ReadCache(redis);
  const [a, b] = [randomUUID(), randomUUID()];
  const device = randomUUID();
  const va = await cache.get(a, "device", [device], async () => ({ owner: a }));
  const vb = await cache.get(b, "device", [device], async () => ({ owner: b }));
  const hitA = await cache.get(a, "device", [device], async () => ({
    owner: "origin",
  }));
  // Plant tenant A's envelope directly under tenant B's key (simulated collision/crafted write).
  const keys = await redis.eval("return redis.call('KEYS', ARGV[1])", {
    keys: [`gg:read:v1:{t:${b}}:gen`],
    arguments: [`gg:read:v1:{t:${b}}:g0:*`],
  });
  const bKey = keys.find((k) => !k.endsWith(":lock"));
  const digest = bKey.split(":").pop();
  await redis.set(bKey, JSON.stringify({ t: a, k: digest, v: { owner: a } }), {
    PX: 60_000,
  });
  const crafted = await cache.get(b, "device", [device], async () => ({
    owner: b,
  }));
  await cache.invalidateTenant(a);
  const genB = await redis.get(`gg:read:v1:{t:${b}}:gen`);
  record(
    "two-tenant isolation",
    va.owner === a &&
      vb.owner === b &&
      hitA.owner === a &&
      crafted.owner === b &&
      genB === null,
    {
      tenantAHit: hitA.owner === a,
      craftedEntryServedToB: crafted.owner !== b,
      mismatches: cache.metrics.snapshot().mismatch,
      tenantBGenerationAfterAInvalidation: genB,
    },
  );
}

async function contention(redis) {
  const cache = new ReadCache(redis, { waitMs: 2_000 });
  const origin = counter({ n: randomUUID() }, 100);
  const key = randomUUID();
  const started = Date.now();
  const values = await Promise.all(
    Array.from({ length: 200 }, () =>
      cache.get(randomUUIDTenant, "c", [key], origin.load),
    ),
  );
  const same = values.every((v) => v.n === origin.value.n);
  record("200 concurrent cold requests", origin.loads === 1 && same, {
    backendLoads: origin.loads,
    allSameValue: same,
    elapsedMs: Date.now() - started,
    lockWaitTimeouts: cache.metrics.snapshot().lock_wait_timeout,
  });
}
const randomUUIDTenant = randomUUID();

async function lockExpiry(redis) {
  const cache = new ReadCache(redis, { lockMs: 100, waitMs: 2_000 });
  let version = 0;
  const load = async () => {
    version++;
    const mine = version;
    await sleep(300);
    return { version: mine };
  };
  const tenant = randomUUID();
  const values = await Promise.all(
    Array.from({ length: 20 }, () => cache.get(tenant, "slow", [], load)),
  );
  const cached = await cache.get(tenant, "slow", [], async () => ({
    version: -1,
  }));
  const m = cache.metrics.snapshot();
  // Loader 300 ms vs lock 100 ms: at most ceil(300/100)+1 overlapping loads.
  record(
    "lock expiry mid-load",
    version <= 4 && values.every((v) => v.version >= 1) && cached.version >= 1,
    {
      backendLoads: version,
      fillRejected: m.fill_rejected,
      fills: m.fill,
      cachedVersion: cached.version,
      cacheEvents: m,
    },
  );
}

async function freshness(redis) {
  const ttlMs = 500;
  const cache = new ReadCache(redis, { ttlMs });
  const tenant = randomUUID();
  const origin = counter("checkpoint-1");
  await cache.get(tenant, "f", [], origin.load);
  const keys = await redis.eval("return redis.call('KEYS', ARGV[1])", {
    keys: [`gg:read:v1:{t:${tenant}}:gen`],
    arguments: [`gg:read:v1:{t:${tenant}}:g0:*`],
  });
  const pttl = await redis.eval("return redis.call('PTTL', KEYS[1])", {
    keys: [keys.find((k) => !k.endsWith(":lock"))],
    arguments: [],
  });
  origin.value = "checkpoint-2";
  const staleBefore = await cache.get(tenant, "f", [], origin.load);
  await cache.invalidateTenant(tenant);
  const afterInvalidate = await cache.get(tenant, "f", [], origin.load);
  origin.value = "checkpoint-3";
  const t0 = Date.now();
  let seen = await cache.get(tenant, "f", [], origin.load);
  while (seen !== "checkpoint-3") {
    await sleep(20);
    seen = await cache.get(tenant, "f", [], origin.load);
  }
  const staleness = Date.now() - t0;
  record(
    "write-then-read freshness and TTL",
    afterInvalidate === "checkpoint-2" &&
      staleness <= ttlMs * 1.2 + 50 &&
      pttl > 0 &&
      pttl <= ttlMs * 1.2,
    {
      servedBeforeInvalidation: staleBefore,
      servedAfterInvalidation: afterInvalidate,
      stalenessWithoutInvalidationMs: staleness,
      boundMs: ttlMs * 1.2,
      initialPttlMs: pttl,
    },
  );
}

async function traffic(cache, durationMs, during) {
  const stats = { ok: 0, failed: 0, maxMs: 0 };
  const tenant = randomUUID();
  const origin = counter("value");
  let running = true;
  const worker = async () => {
    while (running) {
      const t = Date.now();
      try {
        await cache.get(
          tenant,
          "t",
          [Math.floor(Math.random() * 50)],
          origin.load,
        );
        stats.ok++;
      } catch {
        stats.failed++;
      }
      stats.maxMs = Math.max(stats.maxMs, Date.now() - t);
      await sleep(5);
    }
  };
  const workers = Array.from({ length: 20 }, worker);
  const extra = await during();
  await sleep(durationMs);
  running = false;
  await Promise.all(workers);
  return {
    ...stats,
    backendLoads: origin.loads,
    ...cache.metrics.snapshot(),
    ...extra,
  };
}

async function nodeKill(redis) {
  const cache = new ReadCache(redis);
  const victim = NODES.find((n) => primaryOf(n));
  const stats = await traffic(cache, 8_000, async () => {
    await sleep(1_000);
    void dockerAsync("kill", container(victim));
    return {};
  });
  const promoted = await waitFor(() => clusterOk(), 20_000);
  const after = await traffic(new ReadCache(redis), 2_000, async () => ({}));
  docker("start", container(victim));
  const rejoined = await waitFor(() => healthyTopology(), 30_000);
  record(
    "primary kill and replica promotion",
    stats.failed === 0 && promoted && after.failed === 0 && rejoined,
    {
      victim: `redis-node-${victim}`,
      requests: stats.ok,
      failedRequests: stats.failed,
      maxRequestMs: stats.maxMs,
      redisTimeouts: stats.timeout,
      redisErrors: stats.error,
      fallbacks: stats.fallback,
      breakerBypasses: stats.bypass,
      clusterOkAfterFailover: promoted,
      victimRejoinedAsHealthyTopology: rejoined,
      hitsAfterFailover: after.hit,
      fallbacksAfterFailover: after.fallback,
    },
  );
}

async function pause(redis) {
  const cache = new ReadCache(redis);
  const victim = NODES.find((n) => primaryOf(n));
  const stats = await traffic(cache, 6_000, async () => {
    await sleep(500);
    void dockerAsync("pause", container(victim));
    setTimeout(() => void dockerAsync("unpause", container(victim)), 4_000);
    return {};
  });
  await waitFor(() => clusterOk(), 20_000);
  record("docker pause of a primary (partition)", stats.failed === 0, {
    victim: `redis-node-${victim}`,
    requests: stats.ok,
    failedRequests: stats.failed,
    maxRequestMs: stats.maxMs,
    redisTimeouts: stats.timeout,
    fallbacks: stats.fallback,
    breakerBypasses: stats.bypass,
  });
}

async function fullRestart(redis) {
  const cache = new ReadCache(redis);
  let restartError = null;
  let restartPromise = Promise.resolve();
  const restartNodes = async () => {
    try {
      // Restart one node at a time. Simultaneously restarting all Redis Cluster
      // members can leave stale peer addresses and removes every cache endpoint
      // at once; a rolling restart is the availability contract we rely on.
      for (const n of NODES) {
        await promisify(execFile)("docker", [
          "compose",
          "-p",
          PROJECT,
          "-f",
          COMPOSE_FILE,
          "restart",
          `redis-node-${n}`,
        ]);
        const nodeReady = await waitFor(async () => {
          try {
            return cli(n, "ping") === "PONG";
          } catch {
            return false;
          }
        }, 15_000);
        if (!nodeReady || !(await waitFor(() => healthyTopology(), 20_000))) {
          throw new Error(`Redis topology did not recover after restarting node ${n}`);
        }
      }
    } catch (error) {
      restartError = error;
    }
  };

  const stats = await traffic(cache, 12_000, async () => {
    await sleep(500);
    restartPromise = restartNodes();
    return {};
  });
  await restartPromise;
  const ok = restartError === null && healthyTopology();
  const warm = await traffic(new ReadCache(redis), 2_000, async () => ({}));
  record(
    "rolling full cluster restart (cold cache)",
    stats.failed === 0 && ok && warm.failed === 0,
    {
      requests: stats.ok,
      failedRequests: stats.failed,
      maxRequestMs: stats.maxMs,
      redisErrors: stats.error,
      redisTimeouts: stats.timeout,
      fallbacks: stats.fallback,
      topologyHealthyAfterRestart: ok,
      restartError: restartError?.message ?? null,
      hitRatioAfterRestart: +(
        warm.hit / (warm.hit + warm.miss + warm.fallback || 1)
      ).toFixed(3),
    },
  );
}

async function eviction(redis) {
  const cache = new ReadCache(redis);
  const before = NODES.map((n) =>
    Number(/evicted_keys:(\d+)/.exec(cli(n, "info", "stats"))[1]),
  );
  const blob = "x".repeat(200_000);
  const tenants = Array.from({ length: 40 }, () => randomUUID());
  let wrong = 0;
  for (let i = 0; i < 1_200; i++) {
    const tenant = tenants[i % tenants.length];
    const value = await cache.get(
      tenant,
      "big",
      [i],
      async () => `${tenant}:${i}:${blob}`,
    );
    if (!value.startsWith(`${tenant}:${i}:`)) wrong++;
  }
  for (let i = 0; i < 1_200; i += 7) {
    const tenant = tenants[i % tenants.length];
    const value = await cache.get(
      tenant,
      "big",
      [i],
      async () => `${tenant}:${i}:${blob}`,
    );
    if (!value.startsWith(`${tenant}:${i}:`)) wrong++;
  }
  const after = NODES.map((n) =>
    Number(/evicted_keys:(\d+)/.exec(cli(n, "info", "stats"))[1]),
  );
  const evicted = after.reduce((s, v, i) => s + v - before[i], 0);
  record("eviction under maxmemory", evicted > 0 && wrong === 0, {
    writtenMB: +((1_200 * blob.length) / 1e6).toFixed(0),
    evictedKeys: evicted,
    wrongValues: wrong,
    cacheEvents: cache.metrics.snapshot(),
    usedMemory: NODES.map(
      (n) => /used_memory_human:(\S+)/.exec(cli(n, "info", "memory"))[1],
    ),
  });
}

const redis = createReadRedis(env);
redis.client.on("error", () => undefined);
await redis.connect();
const only = process.argv[2];
const scenarios = {
  isolation,
  contention,
  lockExpiry,
  freshness,
  eviction,
  nodeKill,
  pause,
  fullRestart,
};
for (const [name, run] of Object.entries(scenarios)) {
  if (only && only !== name) continue;
  try {
    await run(redis);
  } catch (error) {
    record(name, false, { error: String(error?.stack ?? error) });
  }
}
await redis.close().catch(() => undefined);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
process.exit(failed ? 1 : 0);
