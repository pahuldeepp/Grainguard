// Opt-in live Stage 06 slice: canonical telemetry + grain context through
// risk, CDC, alerts, jobs, RabbitMQ, notification and authenticated ack.
// Run only after migrations, events-up, rabbitmq-up and stage06-connect.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Kafka, logLevel } from "kafkajs";
import pg from "pg";

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
const groups = {
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
async function seedFreshOffsets() {
  admin = kafka.admin();
  await admin.connect();
  const subscriptions = {
    [groups.risk]: [
      "greenguard.inventory.device.v1",
      "greenguard.inventory.lot.v1",
      "greenguard.telemetry.recorded.v1",
    ],
    [groups.alerts]: [
      "greenguard.risk.assessment.v1",
      "greenguard.risk.assessment_invalidated.v1",
    ],
    [groups.jobs]: ["greenguard.alerts.lifecycle.v1"],
  };
  for (const [groupId, topics] of Object.entries(subscriptions)) {
    for (const topic of topics) {
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
          "greenguard.raw.telemetry.outbox",
          "greenguard.raw.risk.outbox",
          "greenguard.raw.alerts.outbox",
        ]) {
          const high = await probe.fetchTopicOffsets(topic);
          const committed = (
            await probe.fetchOffsets({
              groupId: "greenguard-cdc-transformer-v1",
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
  console.log("Transformer caught up with all four raw outbox topics");
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
      // Wheat policy: 25 points per metric at warning level, 50 at critical, alert at 50,
      // critical from 75. Stage 10d routes critical alerts through the serverless path,
      // so this RabbitMQ delivery E2E must drive a warning-severity alert (30 C, 70 % = 50).
      measurements: { temperature_c: 30, relative_humidity_percent: 70 },
    },
  );
  await send("greenguard.inventory.device.v1", registered);
  await send("greenguard.inventory.lot.v1", lot1);
  await send("greenguard.inventory.lot.v1", lot2);
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
    sub: "stage06-operator",
    tenant_id: tenant,
    roles: ["operator"],
    iat: now,
    exp: now + 3600,
  })}`;
  return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
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
  const transformer = buildGo("services/cdc-transformer", "cdc-transformer");
  const jobs = buildGo("services/jobs-worker", "jobs-worker");
  console.log("Stage06 host binaries built");
  start("transformer", transformer, [], ".", {
    KAFKA_BROKERS: broker,
    KAFKA_GROUP_ID: "greenguard-cdc-transformer-v1",
    EVENT_SCHEMA_DIR: path.resolve("contracts/events"),
    HTTP_ADDR: "127.0.0.1:18083",
  });
  await ready(18083, "healthz");
  console.log("Transformer healthy");
  await waitTransformerCaughtUp();
  await seedFreshOffsets();
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
    },
  );
  await ready(18086);
  console.log("Risk engine ready");
  start("alerts", "node", ["dist/main.js"], "services/workflow-alerts", {
    KAFKA_BROKERS: broker,
    ALERTS_KAFKA_GROUP: groups.alerts,
    PORT: "18084",
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: `http://127.0.0.1:${idp.address().port}/jwks`,
  });
  await ready(18084);
  console.log("Alert service ready");
  let jobsProcess = start("jobs", jobs, [], ".", {
    KAFKA_BROKERS: broker,
    JOBS_KAFKA_GROUP: groups.jobs,
    JOBS_HTTP_ADDR: "127.0.0.1:18095",
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
      // Machine API-key lookup is not part of this flow; an inherited token
      // without CONTROL_PLANE_URL would abort startup.
      CONTROL_PLANE_URL: "",
      CONTROL_LOOKUP_TOKEN: "",
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
  const a = stream(),
    b = stream();
  const ra = await feed(a),
    rb = await feed(b);
  console.log("Published two tenant binding, lot and telemetry streams");
  for (const [s, reading] of [
    [a, ra],
    [b, rb],
  ]) {
    await until(
      `risk ${s.tenant}`,
      async () =>
        (
          await query(
            "risk",
            "SELECT count(*)::int AS n FROM risk_assessments WHERE tenant_id=$1 AND source_event_id=$2",
            [s.tenant, reading.event_id],
          )
        )[0].n === 1,
    );
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
      "one alert-open transition must create exactly two channel intents (email and sms)",
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
  idp.close();
  rmSync(work, { recursive: true, force: true });
  // KafkaJS can retain a retry timer after disconnect; all processes and
  // temporary files have already been cleaned up at this point.
  setTimeout(() => process.exit(process.exitCode ?? 0), 1000).unref();
}
