// Opt-in live Stage 06 slice: canonical telemetry + grain context through
// risk, CDC, alerts, jobs, RabbitMQ, notification and authenticated ack.
// Run only after migrations, events-up, rabbitmq-up and stage06-connect.
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Kafka, logLevel } from "kafkajs";
import pg from "pg";
import {
  localShardSelection,
  ownershipSubjects,
  writeServiceRegistry,
} from "./placement-fixture.mjs";

process.loadEnvFile(".env");
const work = mkdtempSync(path.join(tmpdir(), "greenguard-stage06-e2e-"));
const children = [];
const broker = "127.0.0.1:59092";
const stamp = Date.now();
const testId = randomUUID().slice(0, 8);
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const iso = (ms) => new Date(ms).toISOString().replace("Z", "000Z");
const issuer = "https://stage06-e2e.greenguard.invalid/";
const audience = "greenguard-alerts";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwks = JSON.stringify({
  keys: [
    {
      ...publicKey.export({ format: "jwk" }),
      kid: "stage06",
      alg: "RS256",
      use: "sig",
    },
  ],
});
const idp = createServer((_req, res) =>
  res.writeHead(200, { "Content-Type": "application/json" }).end(jwks),
);
const logs = new Map();
let producer;
let admin;
const placementToken = randomBytes(32).toString("hex");
const placements = new Set();
let routingIncarnation = "";
let rabbitVhost;
let rabbitVhostCreated = false;
let isolatedRabbitUrl;
const placementAuthority = createServer((req, res) => {
  const flagTenant = req.url?.match(
    /^\/v1\/internal\/flags\/([0-9a-f-]{36})$/,
  )?.[1];
  if (req.headers.authorization !== `Bearer ${placementToken}`) {
    res.writeHead(404).end();
    return;
  }
  if (flagTenant === "00000000-0000-4000-8000-000000000001") {
    res
      .writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      .end(
        JSON.stringify({
          scope: "global",
          version: 1,
          flags: {},
        }),
      );
    return;
  }
  if (flagTenant && placements.has(flagTenant)) {
    res
      .writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      .end(
        JSON.stringify({
          scope: "tenant",
          tenantId: flagTenant,
          version: 1,
          flags: { "notifications.optional_sends": { value: true } },
        }),
      );
    return;
  }
  const tenant = req.url?.match(
    /^\/v1\/internal\/placements\/([0-9a-f-]{36})$/,
  )?.[1];
  if (!tenant || !placements.has(tenant)) {
    res.writeHead(404).end();
    return;
  }
  res
    .writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    })
    .end(
      JSON.stringify({
        tenantId: tenant,
        shardId: "s1",
        shardIncarnation: routingIncarnation,
        placementEpoch: "1",
        state: "active",
        expiresAt: new Date(Date.now() + 1500).toISOString(),
      }),
    );
});
const groups = {
  transformer: `stage06-cdc-${testId}`,
  risk: `stage06-risk-${testId}`,
  alerts: `stage06-alerts-${testId}`,
  jobs: `stage06-jobs-${testId}`,
};
const kafka = new Kafka({
  clientId: `stage06-e2e-${testId}`,
  brokers: [broker],
  logLevel: logLevel.ERROR,
});

function buildGo(directory, name) {
  const output = path.join(work, name);
  const result = spawnSync("go", ["build", "-o", output, "."], {
    cwd: directory,
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.equal(
    result.status,
    0,
    `${name} build: ${result.stderr?.slice(-1500)}`,
  );
  return output;
}
function rabbitAdmin(...args) {
  const container =
    process.env.STAGE06_RABBITMQ_CONTAINER ?? "greenguard-dev-rabbitmq-1";
  const result = spawnSync(
    "docker",
    ["exec", container, "rabbitmqctl", ...args],
    {
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `rabbitmqctl ${args[0]} failed: ${result.stderr?.slice(-1000)}`,
  );
}
function isolateRabbitVhost() {
  const base = new URL(process.env.RABBITMQ_URL ?? "");
  assert.ok(
    base.hostname && base.username,
    "RABBITMQ_URL must identify the local RabbitMQ instance",
  );
  rabbitVhost = `stage06-${testId}`;
  rabbitAdmin("add_vhost", rabbitVhost);
  rabbitVhostCreated = true;
  rabbitAdmin(
    "set_permissions",
    "-p",
    rabbitVhost,
    decodeURIComponent(base.username),
    ".*",
    ".*",
    ".*",
  );
  base.pathname = `/${rabbitVhost}`;
  isolatedRabbitUrl = base.toString();
}
function start(name, command, args, cwd, env = {}) {
  const p = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  p.stderr.on("data", (chunk) => {
    log = (log + chunk.toString()).slice(-4000);
    logs.set(name, log);
    if (
      process.env.STAGE06_DEBUG === "1" &&
      ["risk", "alerts", "notifications"].includes(name)
    ) {
      process.stderr.write(`[${name}] ${chunk.toString()}`);
    }
  });
  children.push(p);
  return p;
}
async function stop(p) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const done = new Promise((resolve) => p.once("close", resolve));
  p.kill("SIGTERM");
  await Promise.race([done, delay(7000).then(() => p.kill("SIGKILL"))]);
  const index = children.indexOf(p);
  if (index >= 0) children.splice(index, 1);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    for (const child of children) child.kill("SIGTERM");
  });
}
async function seedFreshOffsets() {
  admin = kafka.admin();
  await admin.connect();
  const subscriptions = {
    [groups.transformer]: [
      "greenguard.raw.inventory.outbox",
      "greenguard.raw.control.outbox",
      "greenguard.raw.billing.outbox",
      "greenguard.raw.telemetry.outbox",
      "greenguard.raw.risk.outbox",
      "greenguard.raw.alerts.outbox",
      "greenguard.raw.projection.notifications",
    ],
    [groups.risk]: [
      "greenguard.inventory.device.v1",
      "greenguard.inventory.lot.v1",
      "greenguard.telemetry.recorded.v1",
      "greenguard.telemetry.recorded.v2",
    ],
    [groups.alerts]: [
      "greenguard.risk.assessment.v1",
      "greenguard.risk.assessment.v2",
      "greenguard.risk.assessment_invalidated.v1",
    ],
    [groups.jobs]: ["greenguard.alerts.lifecycle.v1"],
  };
  for (const [groupId, topics] of Object.entries(subscriptions)) {
    for (const topic of topics) {
      console.log(`Seeding isolated group ${groupId} at ${topic} tail`);
      const offsets = await admin.fetchTopicOffsets(topic);
      await admin.setOffsets({
        groupId,
        topic,
        partitions: offsets.map(({ partition, high }) => ({
          partition,
          offset: high,
        })),
      });
      const committed = (
        await admin.fetchOffsets({ groupId, topics: [topic] })
      )[0].partitions;
      for (const { partition, high } of offsets) {
        assert.equal(
          committed.find((item) => item.partition === partition)?.offset,
          high,
          `${groupId} ${topic} p${partition}: seed did not commit the observed high watermark`,
        );
      }
    }
  }
  await admin.disconnect();
  admin = undefined;
  console.log("Fresh consumer groups positioned at current topic tails");
}
async function waitTransformerCaughtUp() {
  const probe = kafka.admin();
  await probe.connect();
  try {
    await until(
      "transformer raw-topic catch-up",
      async () => {
        for (const topic of [
          "greenguard.raw.inventory.outbox",
          "greenguard.raw.control.outbox",
          "greenguard.raw.billing.outbox",
          "greenguard.raw.telemetry.outbox",
          "greenguard.raw.risk.outbox",
          "greenguard.raw.alerts.outbox",
          "greenguard.raw.projection.notifications",
        ]) {
          const high = await probe.fetchTopicOffsets(topic);
          const committed = (
            await probe.fetchOffsets({
              groupId: groups.transformer,
              topics: [topic],
            })
          )[0].partitions;
          if (
            high.some(({ partition, high: offset, low }) => {
              const current = committed.find(
                (item) => item.partition === partition,
              )?.offset;
              // A fresh, empty topic has no committed group offset yet. There is
              // nothing to catch up when its low and high watermarks are equal.
              const emptyUncommitted =
                low === offset && (current === undefined || current === "-1");
              return current !== offset && !emptyUncommitted;
            })
          )
            return false;
        }
        return true;
      },
      90_000,
    );
  } finally {
    await probe.disconnect();
  }
  console.log("Transformer caught up with all seven raw outbox topics");
}
async function until(label, check, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    for (const p of children)
      if (p.exitCode !== null)
        throw new Error(
          `${label}: process exited ${p.pid}; ${[...logs.values()].join("\n").slice(-2500)}`,
        );
    await delay(400);
  }
  throw new Error(
    `${label}: timed out; ${[...logs.values()].join("\n").slice(-2500)}`,
  );
}
async function ready(port, pathName = "readyz") {
  return until(
    `port ${port}`,
    async () => {
      const r = await fetch(`http://127.0.0.1:${port}/${pathName}`, {
        signal: AbortSignal.timeout(1000),
      }).catch(() => null);
      return r?.ok;
    },
    45_000,
  );
}
async function query(database, sql, values = []) {
  const url = new URL(process.env.POSTGRES_ADMIN_URL);
  url.pathname = `/greenguard_${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return (await client.query(sql, values)).rows;
  } finally {
    await client.end();
  }
}
async function withAdmin(database, action) {
  const url = new URL(process.env.POSTGRES_ADMIN_URL);
  url.pathname = `/greenguard_${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}
async function bootstrapTenantOwnership(tenant) {
  const registry = await query(
    "control",
    "SELECT shard_id,shard_incarnation::text AS incarnation,state FROM shard_registry WHERE shard_id='s1'",
  );
  assert.equal(registry.length, 1, "local s1 placement must exist");
  assert.equal(registry[0].state, "active", "local s1 must be active");
  const { shard_id: shardId, incarnation } = registry[0];
  for (const database of [
    "inventory",
    "telemetry",
    "read",
    "risk",
    "alerts",
    "jobs",
    "notifications",
    "sagas",
    "hardware",
  ]) {
    await withAdmin(database, async (client) => {
      await client.query("BEGIN");
      try {
        const subjects = ownershipSubjects([tenant]);
        const existingBySubject = new Map();
        for (const subject of subjects) {
          const existing = await client.query(
            "SELECT shard_id,shard_incarnation::text AS incarnation,placement_epoch,state FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1::uuid",
            [subject],
          );
          existingBySubject.set(subject, existing.rows[0]);
        }
        await client.query("SET LOCAL ROLE tenant_ownership_bootstrap");
        for (const subject of subjects) {
          const current = existingBySubject.get(subject);
          if (
            current &&
            (current.shard_id !== shardId ||
              current.incarnation !== incarnation ||
              Number(current.placement_epoch) !== 1 ||
              !["prepared", "active"].includes(current.state))
          ) {
            throw new Error(
              `${database}/${subject} ownership conflicts with fixture placement`,
            );
          }
          if (current?.state === "active") continue;
          if (!current) {
            await client.query(
              "SELECT greenguard_internal.prepare_tenant_ownership($1::uuid,$2::text,$3::uuid,1)",
              [subject, shardId, incarnation],
            );
          }
          const prepared = await client.query(
            "SELECT state FROM greenguard_internal.get_tenant_ownership_bootstrap_receipt($1::uuid,$2::text,$3::uuid,1)",
            [subject, shardId, incarnation],
          );
          assert.equal(
            prepared.rows[0]?.state,
            "prepared",
            `${database}/${subject} prepared receipt`,
          );
          await client.query(
            "SELECT greenguard_internal.activate_tenant_ownership($1::uuid,$2::text,$3::uuid,1)",
            [subject, shardId, incarnation],
          );
          const active = await client.query(
            "SELECT state FROM greenguard_internal.get_tenant_ownership_bootstrap_receipt($1::uuid,$2::text,$3::uuid,1)",
            [subject, shardId, incarnation],
          );
          assert.equal(
            active.rows[0]?.state,
            "active",
            `${database}/${subject} active receipt`,
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
  }
  return { shardId, incarnation };
}
function isolatedRegistry(service, databaseUrl, incarnations) {
  // s1 is the central local database; s2-s4 are distinct never-connected loopback
  // addresses (no physical shard bundles are required for this slice).
  const database = new URL(databaseUrl).pathname
    .slice(1)
    .replace(/^greenguard_/, "");
  return writeServiceRegistry({
    dir: work,
    service,
    database,
    directUrl: databaseUrl,
    incarnations,
  });
}
function envelope(tenant, type, aggregateType, aggregate, version, payload) {
  return {
    event_id: randomUUID(),
    event_type: type,
    schema_version: 1,
    occurred_at: iso(stamp),
    tenant_id: tenant,
    aggregate_type: aggregateType,
    aggregate_id: aggregate,
    aggregate_version: String(version),
    correlation_id: randomUUID(),
    causation_id: randomUUID(),
    traceparent,
    payload,
  };
}
async function send(topic, event) {
  await producer.send({
    topic,
    messages: [
      {
        key: `${event.tenant_id}:${event.aggregate_id}`,
        value: JSON.stringify(event),
      },
    ],
  });
}
function stream() {
  return {
    tenant: randomUUID(),
    site: randomUUID(),
    bin: randomUUID(),
    device: randomUUID(),
    wheat: randomUUID(),
    canola: randomUUID(),
  };
}
async function feed(s) {
  const first = iso(stamp - 3_600_000),
    second = iso(stamp + 3_600_000),
    observed = iso(stamp);
  const registered = envelope(
    s.tenant,
    "device.registered",
    "device",
    s.device,
    1,
    {
      device_id: s.device,
      serial_number: `E2E-${testId}`,
      site_id: s.site,
      bin_id: s.bin,
      status: "active",
      binding_version: "1",
    },
  );
  const lot1 = envelope(s.tenant, "lot.changed", "bin_occupancy", s.bin, 1, {
    bin_id: s.bin,
    site_id: s.site,
    lot_id: s.wheat,
    grain_type: "wheat",
    variety: null,
    occupancy_version: "1",
    effective_from: first,
    previous_lot_id: null,
  });
  const lot2 = envelope(s.tenant, "lot.changed", "bin_occupancy", s.bin, 2, {
    bin_id: s.bin,
    site_id: s.site,
    lot_id: s.canola,
    grain_type: "canola",
    variety: null,
    occupancy_version: "2",
    effective_from: second,
    previous_lot_id: s.wheat,
  });
  const reading = envelope(
    s.tenant,
    "telemetry.recorded",
    "device_telemetry_stream",
    s.device,
    1,
    {
      reading_id: randomUUID(),
      device_id: s.device,
      site_id: s.site,
      bin_id: s.bin,
      binding_version: "1",
      source_message_id: `e2e-${randomUUID()}`,
      observed_at: observed,
      received_at: observed,
      // Keep both signals elevated but below their critical limits. That produces
      // a warning assessment and exercises the RabbitMQ notification path; critical
      // alerts are intentionally dispatched only through the AWS EventBridge path.
      measurements: { temperature_c: 30, relative_humidity_percent: 70 },
    },
  );
  await send("greenguard.inventory.device.v1", registered);
  await send("greenguard.inventory.lot.v1", lot1);
  await send("greenguard.inventory.lot.v1", lot2);
  // The risk join only scores a reading when the projection's binding/lot
  // source checkpoint covers its event time. Publish the canonical checkpoint
  // marker after the synthetic lot feed, matching the production contract.
  await send("greenguard.inventory.device.v1", {
    event_type: "binding.feed_checkpoint",
    source_time: observed,
  });
  await send("greenguard.telemetry.recorded.v1", reading);
  return reading;
}
function token(tenant) {
  const b64 = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", typ: "JWT", kid: "stage06" })}.${b64({
    iss: issuer,
    aud: audience,
    sub: `stage06-operator-${tenant}`,
    tenant_id: tenant,
    roles: ["operator", "admin"],
    iat: now,
    exp: now + 3600,
  })}`;
  return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
}
async function publishFixturePolicy(tenant) {
  const response = await fetch("http://127.0.0.1:18086/v1/policies", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token(tenant)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      policy_id: randomUUID(),
      version: 1,
      grain_type: "wheat",
      bin_id: null,
      effective_from: iso(stamp - 86_400_000),
      effective_to: null,
      measurement_thresholds: {
        temperature_c: { warning: 25, critical: 35, unit: "Cel" },
        relative_humidity_percent: { warning: 65, critical: 80, unit: "%" },
      },
      risk_thresholds: { warning_score: 50, critical_score: 75 },
      calibrated: true,
      status: "active",
      provenance: {
        source: "stage06-synthetic-fixture",
        data_origin: "synthetic",
      },
      calibration_evidence:
        "Deterministic synthetic acceptance fixture; not production calibration",
      approved_by: `stage06-operator-${tenant}`,
      approved_at: iso(stamp - 60_000),
    }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json().catch(() => null);
  assert.equal(
    response.status,
    201,
    `synthetic risk policy publish: ${JSON.stringify(body)}`,
  );
}
async function api(tenant, route, method = "GET", headers = {}) {
  const r = await fetch(`http://127.0.0.1:18084${route}`, {
    method,
    headers: { Authorization: `Bearer ${token(tenant)}`, ...headers },
    signal: AbortSignal.timeout(5000),
  });
  return {
    status: r.status,
    body: await r.json().catch(() => null),
    etag: r.headers.get("etag"),
  };
}

try {
  await new Promise((resolve) => idp.listen(0, "127.0.0.1", resolve));
  const a = stream(),
    b = stream();
  const placement = await bootstrapTenantOwnership(a.tenant);
  await bootstrapTenantOwnership(b.tenant);
  // Shared local Debezium tails the central dev databases. Temporary four-shard
  // manifests route s1 to those databases while retaining the other local
  // shard endpoints; all three services still use the real resolver + SQL fence.
  routingIncarnation = placement.incarnation;
  const controlShards = await query(
    "control",
    "SELECT shard_id,shard_incarnation::text AS incarnation,state FROM shard_registry ORDER BY shard_id",
  );
  assert.deepEqual(
    controlShards.map((row) => row.shard_id),
    ["s1", "s2", "s3", "s4"],
  );
  assert.equal(
    controlShards.find((row) => row.shard_id === "s1")?.state,
    "active",
    "local shard route s1 must be active",
  );
  const incarnations = Object.fromEntries(
    controlShards.map((row) => [row.shard_id, row.incarnation]),
  );
  const riskRegistryPath = isolatedRegistry(
    "risk-engine",
    process.env.RISK_DATABASE_URL,
    incarnations,
  );
  const alertsRegistryPath = isolatedRegistry(
    "workflow-alerts",
    process.env.ALERTS_DATABASE_URL,
    incarnations,
  );
  const jobsRegistryPath = isolatedRegistry(
    "jobs-worker",
    process.env.JOBS_DATABASE_URL,
    incarnations,
  );
  const notificationRegistryPath = isolatedRegistry(
    "notification-service",
    process.env.NOTIFICATIONS_DATABASE_URL,
    incarnations,
  );
  placements.add(a.tenant);
  placements.add(b.tenant);
  await new Promise((resolve, reject) =>
    placementAuthority.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const placementUrl = `http://127.0.0.1:${placementAuthority.address().port}`;
  const membershipPath = path.join(work, "memberships.json");
  writeFileSync(
    membershipPath,
    JSON.stringify(
      [a, b].map((s) => ({
        issuer,
        subject: `stage06-operator-${s.tenant}`,
        tenantId: s.tenant,
        roles: ["operator", "admin"],
      })),
    ),
    { mode: 0o600 },
  );
  const transformer = buildGo("services/cdc-transformer", "cdc-transformer");
  const jobs = buildGo("services/jobs-worker", "jobs-worker");
  console.log("Stage06 host binaries built");
  await seedFreshOffsets();
  start("transformer", transformer, [], ".", {
    KAFKA_BROKERS: broker,
    KAFKA_GROUP_ID: groups.transformer,
    EVENT_SCHEMA_DIR: path.resolve("contracts/events"),
    HTTP_ADDR: "127.0.0.1:18083",
  });
  await ready(18083, "healthz");
  console.log("Transformer healthy");
  await waitTransformerCaughtUp();
  start(
    "risk",
    path.resolve(".local/risk-venv/bin/python"),
    ["-m", "risk_engine.main"],
    "services/risk-engine",
    {
      KAFKA_BROKERS: broker,
      RISK_KAFKA_GROUP: groups.risk,
      RISK_KAFKA_OFFSET_RESET: "error",
      RISK_HEALTH_PORT: "18086",
      SHARD_REGISTRY_FILE: riskRegistryPath,
      ...localShardSelection(),
      CONTROL_PLANE_URL: placementUrl,
      CONTROL_LOOKUP_TOKEN: placementToken,
      AUTH_ISSUER: issuer,
      AUTH_AUDIENCE: audience,
      AUTH_JWKS_URL: `http://127.0.0.1:${idp.address().port}/jwks`,
      AUTH_MEMBERSHIP_FILE: membershipPath,
    },
  );
  await ready(18086);
  console.log("Risk engine ready");
  await publishFixturePolicy(a.tenant);
  await publishFixturePolicy(b.tenant);
  console.log(
    "Synthetic fixture risk policies published through the authenticated owner API",
  );
  start("alerts", "node", ["dist/main.js"], "services/workflow-alerts", {
    KAFKA_BROKERS: broker,
    ALERTS_KAFKA_GROUP: groups.alerts,
    PORT: "18084",
    ALERTS_ACTOR_HMAC_KEY: "stage06-test-actor-hmac-key-at-least-32-bytes",
    ALERTS_HISTORY_CURSOR_KEY:
      "stage06-test-history-cursor-key-at-least-32-bytes",
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: `http://127.0.0.1:${idp.address().port}/jwks`,
    AUTH_MEMBERSHIP_SOURCE: "file",
    AUTH_MEMBERSHIP_FILE: membershipPath,
    SHARD_REGISTRY_FILE: alertsRegistryPath,
    ...localShardSelection(),
    CONTROL_PLANE_URL: placementUrl,
    CONTROL_LOOKUP_TOKEN: placementToken,
    AUTH_ALLOW_INSECURE_MEMBERSHIP_LOOKUP: "true",
  });
  await ready(18084);
  console.log("Alert service ready");
  // Old shared-queue messages from unrelated local runs must not starve or
  // contaminate this acceptance. A per-run vhost keeps the real RabbitMQ
  // topology and delivery path while isolating only this test's queue state.
  isolateRabbitVhost();
  let jobsProcess = start("jobs", jobs, [], ".", {
    KAFKA_BROKERS: broker,
    RABBITMQ_URL: isolatedRabbitUrl,
    JOBS_KAFKA_GROUP: groups.jobs,
    JOBS_HTTP_ADDR: "127.0.0.1:18095",
    SHARD_REGISTRY_FILE: jobsRegistryPath,
    ...localShardSelection(),
    CONTROL_PLANE_URL: placementUrl,
    CONTROL_LOOKUP_TOKEN: placementToken,
  });
  await until(
    "jobs health",
    async () =>
      (await fetch("http://127.0.0.1:18095/healthz").catch(() => null))?.ok,
    45_000,
  );
  console.log("Jobs worker healthy");
  start(
    "notifications",
    "node",
    ["dist/main.js"],
    "services/notification-service",
    {
      NOTIFICATIONS_HTTP_PORT: "18096",
      NOTIFICATIONS_PROVIDER: "local",
      RABBITMQ_URL: isolatedRabbitUrl,
      // This slice exercises the actual local flag snapshot gate. Avoid
      // inheriting a Kafka flag-feed consumer because its offsets belong to the
      // long-running local stack, not this isolated fixture.
      KAFKA_BROKERS: "",
      SHARD_REGISTRY_FILE: notificationRegistryPath,
      SHARD_ROUTING_REQUIRED: "true",
      ...localShardSelection(),
      CONTROL_PLANE_URL: placementUrl,
      CONTROL_LOOKUP_TOKEN: placementToken,
      // The local fixture serves authenticated placement and flag snapshots;
      // permit HTTP only for this local non-live notification test provider.
      NOTIFICATIONS_ALLOW_INSECURE_CONTACT_LOOKUP: "true",
    },
  );
  await until(
    "notifications health",
    async () =>
      (await fetch("http://127.0.0.1:18096/healthz").catch(() => null))?.ok,
    45_000,
  );
  console.log("Notification worker healthy");
  producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();
  const ra = await feed(a),
    rb = await feed(b);
  console.log("Published two tenant binding, lot and telemetry streams");
  for (const [s, reading] of [
    [a, ra],
    [b, rb],
  ]) {
    await until(`risk ${s.tenant}`, async () => {
      const [assessment] = await query(
        "risk",
        "SELECT count(*)::int AS n, max(severity) AS severity FROM risk_assessments WHERE tenant_id=$1 AND source_event_id=$2",
        [s.tenant, reading.event_id],
      );
      return assessment.n === 1 && assessment.severity === "warning";
    });
    console.log(`Risk assessment committed for tenant ${s.tenant}`);
    await until(
      `alert ${s.tenant}`,
      async () =>
        (
          await query(
            "alerts",
            "SELECT episode_id, version FROM alert_episodes WHERE tenant_id=$1 AND monitored_resource_id=$2",
            [s.tenant, s.bin],
          )
        )[0],
    );
    console.log(`Alert episode committed for tenant ${s.tenant}`);
    await until(
      `jobs ${s.tenant}`,
      async () =>
        (
          await query(
            "jobs",
            "SELECT count(*)::int AS n FROM notification_intents WHERE tenant_id=$1",
            [s.tenant],
          )
        )[0].n >= 1,
    );
    console.log(`Jobs intent committed for tenant ${s.tenant}`);
    await until(
      `delivery ${s.tenant}`,
      async () =>
        (
          await query(
            "notifications",
            "SELECT count(*)::int AS n FROM deliveries WHERE tenant_id=$1 AND status='sent'",
            [s.tenant],
          )
        )[0].n >= 1,
    );
    console.log(`Notification sent for tenant ${s.tenant}`);
  }
  const aEpisode = (
    await query(
      "alerts",
      "SELECT episode_id FROM alert_episodes WHERE tenant_id=$1 AND monitored_resource_id=$2",
      [a.tenant, a.bin],
    )
  )[0].episode_id;
  const foreign = await api(b.tenant, `/v1/alerts/${aEpisode}`);
  assert.equal(
    foreign.status,
    404,
    "second tenant read another tenant's episode",
  );
  const own = await api(a.tenant, `/v1/alerts/${aEpisode}`);
  assert.equal(own.status, 200);
  const ack = await api(
    a.tenant,
    `/v1/alerts/${aEpisode}/acknowledge`,
    "POST",
    { "Idempotency-Key": `stage06-${testId}`, "If-Match": own.etag },
  );
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  await until(
    "ack lifecycle",
    async () =>
      (
        await query(
          "alerts",
          "SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id=$1 AND event_type='alert.acknowledged'",
          [a.tenant],
        )
      )[0].n === 1,
  );
  const killed = new Promise((resolve) => jobsProcess.once("close", resolve));
  jobsProcess.kill("SIGKILL");
  await killed;
  children.splice(children.indexOf(jobsProcess), 1);
  jobsProcess = start("jobs-restarted", jobs, [], ".", {
    KAFKA_BROKERS: broker,
    RABBITMQ_URL: isolatedRabbitUrl,
    JOBS_KAFKA_GROUP: groups.jobs,
    JOBS_HTTP_ADDR: "127.0.0.1:18095",
  });
  await until(
    "jobs restart",
    async () =>
      (await fetch("http://127.0.0.1:18095/healthz").catch(() => null))?.ok,
    45_000,
  );
  const opened = (
    await query(
      "alerts",
      "SELECT * FROM outbox_events WHERE tenant_id=$1 AND event_type='alert.opened' ORDER BY occurred_at LIMIT 1",
      [a.tenant],
    )
  )[0];
  assert.ok(opened, "alert owner did not persist opened outbox event");
  const duplicateAlert = {
    event_id: opened.event_id,
    event_type: opened.event_type,
    schema_version: opened.schema_version,
    occurred_at: iso(opened.occurred_at.getTime()),
    tenant_id: opened.tenant_id,
    aggregate_type: opened.aggregate_type,
    aggregate_id: opened.aggregate_id,
    aggregate_version: String(opened.aggregate_version),
    correlation_id: opened.correlation_id,
    causation_id: opened.causation_id,
    traceparent: opened.traceparent,
    payload: opened.payload,
  };
  await send("greenguard.alerts.lifecycle.v1", duplicateAlert);
  console.log(
    "Replayed the original alert.opened event after jobs-worker SIGKILL/restart",
  );
  // Broker redelivery is at least once; a duplicate canonical reading must not
  // produce another risk result, alert episode or notification intent.
  await send("greenguard.telemetry.recorded.v1", ra);
  await delay(2500);
  assert.equal(
    (
      await query(
        "risk",
        "SELECT count(*)::int AS n FROM risk_assessments WHERE tenant_id=$1 AND source_event_id=$2",
        [a.tenant, ra.event_id],
      )
    )[0].n,
    1,
  );
  for (const s of [a, b]) {
    assert.equal(
      (
        await query(
          "jobs",
          "SELECT count(*)::int AS n FROM notification_intents WHERE tenant_id=$1",
          [s.tenant],
        )
      )[0].n,
      2,
      "one warning alert-open transition must create exactly two channel intents",
    );
  }
  assert.equal(
    (
      await query(
        "alerts",
        "SELECT count(*)::int AS n FROM alert_episodes WHERE tenant_id=$1 AND monitored_resource_id=$2",
        [a.tenant, a.bin],
      )
    )[0].n,
    1,
  );
  console.log(
    "PASS Stage06: two tenants, canonical reading → risk → CDC → alert → CDC → jobs → RabbitMQ → delivery; tenant-isolated ack and replay",
  );
} finally {
  const boundedDisconnect = async (client) => {
    if (!client) return;
    await Promise.race([
      client.disconnect().catch(() => undefined),
      delay(3000),
    ]);
  };
  await boundedDisconnect(admin);
  await boundedDisconnect(producer);
  for (const p of [...children].reverse()) await stop(p);
  if (rabbitVhostCreated) {
    rabbitAdmin("delete_vhost", rabbitVhost);
  }
  idp.close();
  placementAuthority.close();
  rmSync(work, { recursive: true, force: true });
  // KafkaJS can retain a retry timer after disconnect; all processes and
  // temporary files have already been cleaned up at this point.
  setTimeout(() => process.exit(process.exitCode ?? 0), 1000).unref();
}
