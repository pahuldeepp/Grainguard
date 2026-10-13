#!/usr/bin/env node
// Local authenticated telemetry-ingest baseline. This writes synthetic readings
// into the configured local telemetry database and deletes the fixture tenant
// afterward. It intentionally does not claim Kafka/CDC/projection/Cassandra E2E.
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import {
  bootstrapTenantOwnership,
  controlIncarnations,
  localShardSelection,
  startPlacementAuthority,
  writeServiceRegistry,
} from "../placement-fixture.mjs";

const root = process.cwd();
process.loadEnvFile(path.join(root, ".env"));
const acknowledgement = "I_ACCEPT_WRITING_LOCAL_SYNTHETIC_READINGS";
if (process.env.GG_PERF_LOCAL_ACK !== acknowledgement) {
  throw new Error(`Set GG_PERF_LOCAL_ACK=${acknowledgement} to run this local write test`);
}

const direct = new URL(process.env.TELEMETRY_DIRECT_URL ?? "");
const adminURL = new URL(process.env.POSTGRES_ADMIN_URL ?? "");
const expectedPort = String(process.env.POSTGRES_HOST_PORT ?? "");
const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
if (!loopback.has(direct.hostname) || !loopback.has(adminURL.hostname) ||
    !expectedPort || direct.port !== expectedPort || adminURL.port !== expectedPort ||
    direct.pathname !== "/greenguard_telemetry") {
  throw new Error("Refusing load run: telemetry/admin URLs must target the configured local PostgreSQL port and telemetry database");
}

const rate = Number(process.env.RATE ?? "10");
const duration = process.env.DURATION ?? "30s";
const preAllocatedVUs = Number(process.env.PREALLOCATED_VUS ?? "32");
const maxVUs = Number(process.env.MAX_VUS ?? "128");
if (!Number.isInteger(rate) || rate < 1 || rate > 50_000 ||
    !Number.isInteger(preAllocatedVUs) || preAllocatedVUs < 1 ||
    !Number.isInteger(maxVUs) || maxVUs < preAllocatedVUs ||
    !/^\d+(s|m)$/.test(duration)) {
  throw new Error("Invalid RATE/DURATION/VU configuration");
}
const durationMatch = duration.match(/^(\d+)(s|m)$/);
const durationSeconds = Number(durationMatch[1]) * (durationMatch[2] === "m" ? 60 : 1);
if (durationSeconds > 6 * 60 * 60) throw new Error("DURATION cannot exceed six hours");

const tenant = randomUUID();
const site = randomUUID();
const devices = Array.from({ length: 256 }, () => randomUUID());
const runId = `local-${Date.now().toString(36)}`;
let work;
const children = new Set();
let interrupted = null;
const handleInterrupt = (signal) => {
  interrupted ??= signal;
  for (const child of children) child.kill("SIGTERM");
};
const handleSigint = () => handleInterrupt("SIGINT");
const handleSigterm = () => handleInterrupt("SIGTERM");
process.on("SIGINT", handleSigint);
process.on("SIGTERM", handleSigterm);
const issuer = "http://127.0.0.1";
const audience = "greenguard-ingest";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
let idp;
let placement;
let ownershipBootstrapped = false;
let k6Status = 1;
let summary;
let failure;
let jwksRequests = 0;

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(issuerURL) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", typ: "JWT", kid: "local-load" })}.${b64({
    iss: issuerURL, aud: audience, sub: "local-load-operator", tenant_id: tenant,
    roles: ["operator"], iat: now, exp: now + durationSeconds + 300,
  })}`;
  return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? "spawn error"})`);
  return result.stdout.trim();
}

function start(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: "ignore" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function ready(url) {
  for (let i = 0; i < 100; i++) {
    if (interrupted) throw new Error(`load run interrupted by ${interrupted}`);
    if (await fetch(url, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("telemetry-ingest did not become ready");
}

async function seedFixtures(incarnations) {
  await bootstrapTenantOwnership([tenant], ["telemetry"], incarnations);
  ownershipBootstrapped = true;
  const dbURL = new URL(adminURL.toString());
  dbURL.pathname = "/greenguard_telemetry";
  const client = new pg.Client({ connectionString: dbURL.toString() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await client.query("SELECT set_config('app.shard_id','s1',true)");
    await client.query("SELECT set_config('app.shard_incarnation',$1,true)", [incarnations.s1]);
    await client.query("SELECT set_config('app.placement_epoch','1',true)");
    for (const device of devices) {
      await client.query(
        `INSERT INTO device_bindings(tenant_id,device_id,site_id,inventory_version,status)
         VALUES($1,$2,$3,1,'active')`, [tenant, device, site]);
      await client.query(
        `INSERT INTO device_streams(tenant_id,device_id,last_version) VALUES($1,$2,0)`, [tenant, device]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function cleanupFixture() {
  if (!ownershipBootstrapped) return;
  const dbURL = new URL(adminURL.toString());
  dbURL.pathname = "/greenguard_telemetry";
  const client = new pg.Client({ connectionString: dbURL.toString() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const tables = await client.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name='tenant_id'
        GROUP BY table_name ORDER BY table_name`,
    );
    for (const { table_name } of tables.rows) {
      await client.query(`DELETE FROM public.${pg.escapeIdentifier(table_name)} WHERE tenant_id=$1`, [tenant]);
    }
    await client.query("DELETE FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1", [tenant]);
    await client.query("COMMIT");
    ownershipBootstrapped = false;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

let evidencePath;
try {
  work = mkdtempSync(path.join(tmpdir(), "greenguard-ingest-load-"));
  chmodSync(work, 0o700);
  const incarnations = await controlIncarnations();
  placement = await startPlacementAuthority(incarnations);
  placement.add(tenant);
  await seedFixtures(incarnations);

  idp = createServer((req, res) => {
    jwksRequests++;
    if (req.url !== "/jwks") return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "local-load", alg: "RS256", use: "sig" }] }));
  });
  await new Promise((resolve, reject) => idp.once("error", reject).listen(0, "127.0.0.1", resolve));
  const issuerURL = `http://127.0.0.1:${idp.address().port}`;
  const fixturePath = path.join(work, "fixtures.json");
  writeFileSync(fixturePath, JSON.stringify({ tenants: [{ bearer_token: token(issuerURL), device_ids: devices }] }), { mode: 0o600 });

  const registryPath = writeServiceRegistry({
    dir: path.join(work, "registry"), service: "telemetry-ingest", database: "telemetry",
    directUrl: process.env.TELEMETRY_DIRECT_URL, incarnations,
  });
  const servicePortServer = await import("node:net").then(({ createServer: netServer }) => new Promise((resolve, reject) => {
    const server = netServer();
    server.once("error", reject).listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  }));
  const binary = path.join(work, "telemetry-ingest");
  run("go", ["build", "-o", binary, "."], { cwd: path.join(root, "services/telemetry-ingest") });
  const service = start(binary, [], {
    ...process.env,
    HTTP_ADDR: `127.0.0.1:${servicePortServer}`,
    SHARD_ROUTING_REQUIRED: "true",
    SHARD_REGISTRY_FILE: registryPath,
    ...localShardSelection(),
    CONTROL_PLANE_URL: placement.url,
    CONTROL_LOOKUP_TOKEN: placement.token,
    KAFKA_BROKERS: "",
    AUTH_ISSUER: issuerURL,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: `${issuerURL}/jwks`,
    INGEST_BINDING_FEED_MAX_STALE: "0",
    INGEST_TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    INGEST_DEVICE_RATE: "1000000", INGEST_DEVICE_BURST: "1000000",
    INGEST_TENANT_RATE: "1000000", INGEST_TENANT_BURST: "1000000",
  });
  await ready(`http://127.0.0.1:${servicePortServer}/readyz`);

  evidencePath = path.join(work, "k6-summary.json");
  const k6 = spawn("k6", ["run", "--summary-export", evidencePath, "tests/performance/telemetry-ingest.js"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      GREENGUARD_LOAD_TARGET: "local",
      SIMULATE_TRUSTED_PROXY: "true",
      BASE_URL: `http://127.0.0.1:${servicePortServer}`,
      EXPECTED_BASE_URL: `http://127.0.0.1:${servicePortServer}`,
      FIXTURES_FILE: fixturePath,
      RUN_ID: runId,
      RATE: String(rate), DURATION: duration,
      PREALLOCATED_VUS: String(preAllocatedVUs), MAX_VUS: String(maxVUs),
    },
  });
  children.add(k6);
  k6.once("exit", () => children.delete(k6));
  k6Status = await new Promise((resolve, reject) => {
    k6.once("error", reject);
    k6.once("close", (code) => resolve(code ?? 1));
  });
  console.log(`Temporary local JWKS requests served: ${jwksRequests}`);
  if (existsSync(evidencePath)) summary = JSON.parse(readFileSync(evidencePath, "utf8"));
  if (k6Status !== 0) throw new Error(`k6 exited ${k6Status}`);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await Promise.all([...children].map(stop));
  if (idp) await new Promise((resolve) => idp.close(resolve));
  placement?.close();
  try { await cleanupFixture(); } catch (error) {
    failure = `${failure ? `${failure}; ` : ""}fixture cleanup failed: ${error.message}`;
  }
  if (work) {
    try { rmSync(work, { recursive: true, force: true }); } catch (error) {
      failure = `${failure ? `${failure}; ` : ""}temporary credential cleanup failed: ${error.message}`;
    }
  }
  if (interrupted) failure = `${failure ? `${failure}; ` : ""}load run interrupted by ${interrupted}`;
  process.off("SIGINT", handleSigint);
  process.off("SIGTERM", handleSigterm);
}
if (summary) {
  const dir = path.join(root, "evidence", "performance");
  mkdirSync(dir, { recursive: true });
  const output = path.join(dir, `local-telemetry-ingest-${runId}.json`);
  const metrics = summary.metrics ?? {};
  const value = (name, key) => {
    const entry = metrics[name] ?? Object.entries(metrics).find(([candidate]) => candidate.startsWith(`${name}{`))?.[1];
    return entry?.values?.[key] ?? entry?.[key] ?? null;
  };
  const measured = {
    accepted: value("greenguard_ingest_accepted", "count"),
    acceptedRate: value("greenguard_ingest_accepted_rate", "rate") ?? value("greenguard_ingest_accepted_rate", "value"),
    requestRate: value("http_reqs", "rate"),
    requestFailureRate: value("http_req_failed", "rate") ?? value("http_req_failed", "value"),
    requestP95Ms: value("http_req_duration", "p(95)"),
    droppedIterations: value("dropped_iterations", "count"),
  };
  const missing = Object.entries(measured).filter(([, measurement]) => measurement === null).map(([name]) => name);
  if (missing.length) {
    failure = `${failure ? `${failure}; ` : ""}k6 summary omitted expected metric values: ${missing.join(", ")}`;
  } else {
    try {
      writeFileSync(output, JSON.stringify({
        runId,
        measuredAt: new Date().toISOString(),
        scope: "authenticated telemetry HTTP endpoint to PostgreSQL transaction; loopback is the only trusted proxy and k6 supplies distinct RFC 2544 client IPs; Kafka, CDC, projections, Cassandra and alerts are not exercised",
        offeredRatePerSecond: rate,
        duration,
        ...measured,
        thresholdsPassed: k6Status === 0,
        syntheticFixtureCleaned: !ownershipBootstrapped,
      }, null, 2) + "\n", { mode: 0o600 });
      console.log(`Local HTTP-to-PostgreSQL baseline saved: ${path.relative(root, output)}`);
    } catch (error) {
      failure = `${failure ? `${failure}; ` : ""}evidence save failed: ${error.message}`;
    }
  }
}
if (failure) {
  console.error(`Local telemetry load baseline failed: ${failure}`);
  process.exitCode = 1;
} else if (!summary) {
  console.error("Local telemetry load baseline produced no k6 summary");
  process.exitCode = 1;
}
