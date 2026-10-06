#!/usr/bin/env node
// Local single-machine load test of the Read API with the Redis Cluster cache (ADR-0015).
// NOT a Tier 1 certification. Opt-in: `make redis-load` (needs `make redis-up`, the read
// database and a built read-api). Auth is stubbed; the routes, RLS reads and cache are real.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import pg from "pg";
import { createApp } from "../services/read-api/dist/app.js";
import { postgresReads } from "../services/read-api/dist/backends.js";
import { cacheBackends } from "../services/read-api/dist/cache.js";
import { createReadRedis } from "../services/read-api/dist/redis.js";

const NODES = [1, 2, 3, 4, 5, 6];
const PHASE_MS = Number(process.env.REDIS_LOAD_PHASE_MS ?? 20_000);
const CONCURRENCY = Number(process.env.REDIS_LOAD_CONCURRENCY ?? 50);
const HOT_SHARE = 0.8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => promisify(execFile)("docker", args);

const adminUrl = new URL(process.env.POSTGRES_ADMIN_URL);
adminUrl.pathname = "/greenguard_read";
const admin = new pg.Pool({ connectionString: adminUrl.toString() });
const pool = new pg.Pool({
  connectionString: process.env.READ_QUERY_DATABASE_URL,
  max: 10,
});
const tenants = workerData?.tenants ?? [randomUUID(), randomUUID()];
const devices =
  workerData?.devices ?? Array.from({ length: 400 }, () => randomUUID());
const hot = devices.slice(0, 20);

async function seed() {
  const site = randomUUID();
  for (const tenant of tenants)
    for (const device of devices)
      await admin.query(
        "INSERT INTO public.device_views(tenant_id,device_id,site_id,serial_number,status,inventory_version) VALUES($1,$2,$3,$4,'active',1)",
        [tenant, device, site, `redis-load-${device}`],
      );
}

function serve(backends) {
  const app = createApp({
    verify: async (header) => ({
      subject: "load",
      tenantId: header.slice("Bearer ".length),
      roles: ["viewer"],
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
    backends,
  });
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function pick() {
  const list = Math.random() < HOT_SHARE ? hot : devices;
  const device = list[Math.floor(Math.random() * list.length)];
  const route = Math.random() < 0.5 ? "" : "/latest";
  return {
    tenant: tenants[Math.floor(Math.random() * 2)],
    path: `/api/v1/read/devices/${device}${route}`,
  };
}

function percentile(sorted, p) {
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
    : 0;
}

async function run(label, port, metrics, disrupt) {
  const base = `http://127.0.0.1:${port}`;
  const latencies = [];
  let errors = 0;
  const before = await metrics?.();
  const end = Date.now() + PHASE_MS;
  const worker = async () => {
    while (Date.now() < end) {
      const { tenant, path } = pick();
      const t = performance.now();
      const response = await fetch(base + path, {
        headers: { authorization: `Bearer ${tenant}` },
      }).catch(() => null);
      if (!response?.ok) errors++;
      await response?.arrayBuffer();
      latencies.push(performance.now() - t);
    }
  };
  const disruption = disrupt?.();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await disruption;
  latencies.sort((a, b) => a - b);
  const after = await metrics?.();
  const delta = (k) => (after ? after[k] - before[k] : 0);
  const lookups = delta("hit") + delta("miss");
  const result = {
    phase: label,
    requests: latencies.length,
    throughputRps: Math.round(latencies.length / (PHASE_MS / 1000)),
    p50ms: +percentile(latencies, 50).toFixed(2),
    p95ms: +percentile(latencies, 95).toFixed(2),
    p99ms: +percentile(latencies, 99).toFixed(2),
    maxMs: +latencies.at(-1).toFixed(2),
    errorRate: +(errors / latencies.length).toFixed(5),
    hitRatio: after ? +(delta("hit") / (lookups || 1)).toFixed(3) : null,
    redisTimeouts: delta("timeout"),
    redisErrors: delta("error"),
    fallbacks: delta("fallback"),
    breakerBypasses: delta("bypass"),
    originLoads: delta("load"),
  };
  console.log(JSON.stringify(result));
  return result;
}

async function primary() {
  for (const n of NODES) {
    const { stdout } = await docker(
      "exec",
      `greenguard-redis-redis-node-${n}-1`,
      "redis-cli",
      "role",
    );
    if (stdout.startsWith("master")) return n;
  }
  throw new Error("no primary");
}

// The Read API runs in its own thread so the load generator cannot starve its event loop.
async function serverThread() {
  const direct = await serve(postgresReads(pool));
  const redis = createReadRedis({
    READ_REDIS_CLUSTER_NODES: NODES.map(
      (n) => `redis://127.0.0.1:710${n}`,
    ).join(","),
    READ_REDIS_NODE_ADDRESS_MAP: NODES.map(
      (n) => `redis-node-${n}:6379=127.0.0.1:710${n}`,
    ).join(","),
  });
  redis.client.on("error", () => undefined);
  await redis.connect();
  const reads = cacheBackends(postgresReads(pool), redis);
  const cached = await serve(reads);
  parentPort.on("message", async (msg) => {
    if (msg === "metrics")
      parentPort.postMessage({ metrics: reads.cache.metrics.snapshot() });
    if (msg === "stop") {
      direct.close();
      cached.close();
      await Promise.all([pool.end(), redis.close().catch(() => undefined)]);
      parentPort.close();
    }
  });
  parentPort.postMessage({
    direct: direct.address().port,
    cached: cached.address().port,
  });
}

function request(worker, msg) {
  return new Promise((resolve) => {
    worker.once("message", resolve);
    worker.postMessage(msg);
  });
}

async function mainThread() {
  await seed();
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { tenants, devices },
  });
  const ports = await new Promise((resolve) => worker.once("message", resolve));
  const metrics = async () => (await request(worker, "metrics")).metrics;
  console.log(
    `# local single-machine measurement, ${CONCURRENCY} concurrent clients, ${PHASE_MS} ms per phase, ${HOT_SHARE * 100}% hot keys; not Tier 1 evidence`,
  );
  try {
    await run("no-cache baseline (Postgres only)", ports.direct, null);
    await run("cache warm steady state", ports.cached, metrics);
    const victim = await primary();
    await run(
      `cache with primary redis-node-${victim} killed at +5s`,
      ports.cached,
      metrics,
      async () => {
        await sleep(5_000);
        await docker("kill", `greenguard-redis-redis-node-${victim}-1`);
      },
    );
    await docker("start", `greenguard-redis-redis-node-${victim}-1`);
  } finally {
    worker.postMessage("stop");
    await admin.query(
      "DELETE FROM public.device_views WHERE tenant_id = ANY($1::uuid[])",
      [tenants],
    );
    await Promise.all([admin.end(), pool.end()]);
  }
}

if (isMainThread) await mainThread();
else await serverThread();
