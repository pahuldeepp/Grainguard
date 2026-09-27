// Opt-in Stage 09f transport check. Requires make events-up rabbitmq-up jobs-migrate
// and a migrated control plane. Uses a fresh tenant; no global configuration changes.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Kafka, logLevel } from "kafkajs";
import kafkaJs from "kafkajs";
import { createRequire } from "node:module";
import amqp from "amqplib";
import pg from "pg";

process.loadEnvFile(".env");
const { CompressionCodecs, CompressionTypes } = kafkaJs;
CompressionCodecs[CompressionTypes.Snappy] = createRequire(import.meta.url)(
  "kafkajs-snappy",
);
const required = [
  "CONTROL_DATABASE_URL",
  "CONTROL_LOOKUP_TOKEN",
  "NOTIFICATIONS_DATABASE_URL",
  "RABBITMQ_URL",
  "POSTGRES_ADMIN_URL",
];
for (const key of required) assert.ok(process.env[key], `${key} is required`);
const broker = process.env.KAFKA_BROKERS ?? "127.0.0.1:59092";
const work = mkdtempSync(path.join(tmpdir(), "greenguard-stage09f-"));
const children = [];
const logs = new Map();
const issuer = "https://stage09f-e2e.greenguard.invalid/";
const audience = "greenguard-control";
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwks = JSON.stringify({
  keys: [
    {
      ...publicKey.export({ format: "jwk" }),
      kid: "stage09f",
      alg: "RS256",
      use: "sig",
    },
  ],
});
const idp = createServer((_req, res) =>
  res.writeHead(200, { "Content-Type": "application/json" }).end(jwks),
);
const kafka = new Kafka({
  clientId: `stage09f-e2e-${randomUUID()}`,
  brokers: [broker],
  logLevel: logLevel.ERROR,
});
let producer, observer, rabbit, channel;

function start(name, command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) =>
    logs.set(name, ((logs.get(name) ?? "") + chunk.toString()).slice(-4000)),
  );
  children.push(child);
  return child;
}
async function until(label, check, ms = 45_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (
      await Promise.resolve()
        .then(check)
        .catch(() => false)
    )
      return;
    await delay(150);
  }
  throw new Error(
    `${label} timed out; logs: ${JSON.stringify(Object.fromEntries(logs))}`,
  );
}
async function ready(port) {
  await until(
    `ready :${port}`,
    async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).ok,
  );
}
function token() {
  const b64 = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: "RS256", kid: "stage09f", typ: "JWT" })}.${b64({ iss: issuer, aud: audience, sub: `stage09f-${process.pid}`, iat: now, exp: now + 3600 })}`;
  return `${data}.${sign("sha256", Buffer.from(data), privateKey).toString("base64url")}`;
}
async function control(method, pathName, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:19098${pathName}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      ...(body && { "content-type": "application/json" }),
      ...headers,
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}
async function notificationsRows(sql, values) {
  const url = new URL(process.env.POSTGRES_ADMIN_URL);
  url.pathname = "/greenguard_notifications";
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    return (await db.query(sql, values)).rows;
  } finally {
    await db.end();
  }
}
async function publishTask(tenantId) {
  const intent = randomUUID();
  const task = {
    intent_id: intent,
    tenant_id: tenantId,
    channel: "email",
    transition: "alert.opened",
    severity: "warning",
    alert_id: randomUUID(),
    episode_id: randomUUID(),
    transition_version: 1,
    delivery_generation: 0,
    correlation_id: randomUUID(),
    traceparent,
  };
  channel.publish(
    "greenguard.notifications",
    "task",
    Buffer.from(JSON.stringify(task)),
    { persistent: true, contentType: "application/json", messageId: intent },
  );
  await channel.waitForConfirms();
  return intent;
}
async function heldCount() {
  const response = await fetch("http://127.0.0.1:19096/metrics");
  const text = await response.text();
  return Number(
    /^notifications_optional_held_total (\d+)$/m.exec(text)?.[1] ?? 0,
  );
}
async function claimHeldRetry(intentId) {
  const others = [];
  let found = false;
  try {
    for (let i = 0; i < 100; i++) {
      const message = await channel.get("notifications.retry", {
        noAck: false,
      });
      if (!message) break;
      if (message.properties.messageId === intentId) {
        assert.equal(
          JSON.parse(message.content.toString("utf8")).intent_id,
          intentId,
        );
        channel.ack(message); // Remove only this isolated test task.
        found = true;
        break;
      }
      others.push(message);
    }
  } finally {
    for (const message of others) channel.nack(message, false, true);
  }
  return found;
}
const observed = [];
try {
  await new Promise((resolve) => idp.listen(0, "127.0.0.1", resolve));
  const binary = path.join(work, "cdc-transformer");
  const build = spawnSync("go", ["build", "-o", binary, "."], {
    cwd: "services/cdc-transformer",
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.equal(build.status, 0, build.stderr?.slice(-2000));
  start("transformer", binary, [], ".", {
    KAFKA_BROKERS: broker,
    KAFKA_GROUP_ID: "greenguard-cdc-transformer-v1",
    EVENT_SCHEMA_DIR: path.resolve("contracts/events"),
    HTTP_ADDR: "127.0.0.1:19083",
  });
  await ready(19083);
  start("control", "node", ["dist/main.js"], "services/tenant-control-plane", {
    PORT: "19098",
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: `http://127.0.0.1:${idp.address().port}/jwks`,
  });
  await ready(19098);
  start(
    "notifications",
    "node",
    ["dist/main.js"],
    "services/notification-service",
    {
      NOTIFICATIONS_HTTP_PORT: "19096",
      NOTIFICATIONS_PROVIDER: "local",
      KAFKA_BROKERS: broker,
      CONTROL_PLANE_URL: "http://127.0.0.1:19098",
    },
  );
  await ready(19096);
  rabbit = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await rabbit.createConfirmChannel();
  producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();
  observer = kafka.consumer({ groupId: `stage09f-observer-${randomUUID()}` });
  await observer.connect();
  await observer.subscribe({
    topic: "greenguard.platform.config.v1",
    fromBeginning: false,
  });
  await observer.run({
    eachMessage: async ({ message }) => {
      try {
        observed.push(JSON.parse(message.value.toString("utf8")));
      } catch {
        return;
      }
    },
  });

  const created = await control(
    "POST",
    "/v1/organizations",
    { name: `Stage 09f E2E ${randomUUID()}` },
    { "idempotency-key": randomUUID() },
  );
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const tenantId = created.json.tenantId;
  const flagPath = `/v1/organizations/${tenantId}/flags`;
  const enabled = await control(
    "PUT",
    flagPath,
    { flags: { "notifications.optional_sends": { value: true } } },
    { "idempotency-key": randomUUID(), "if-match": '"0"' },
  );
  assert.equal(enabled.status, 200, JSON.stringify(enabled.json));
  await until(
    "CDC flag version 1",
    () =>
      observed.some(
        (event) =>
          event.tenant_id === tenantId &&
          event.event_type === "flag.configuration_changed" &&
          event.aggregate_version === "1",
      ),
    90_000,
  );
  const version1 = observed.find(
    (event) =>
      event.tenant_id === tenantId &&
      event.event_type === "flag.configuration_changed" &&
      event.aggregate_version === "1",
  );
  const sentIntent = await publishTask(tenantId);
  await until(
    "optional send",
    async () =>
      (
        await notificationsRows(
          "SELECT status FROM deliveries WHERE tenant_id=$1 AND intent_id=$2",
          [tenantId, sentIntent],
        )
      )[0]?.status === "sent",
    30_000,
  );

  const disabled = await control(
    "PUT",
    flagPath,
    { flags: { "notifications.optional_sends": { value: false } } },
    { "idempotency-key": randomUUID(), "if-match": '"1"' },
  );
  assert.equal(disabled.status, 200, JSON.stringify(disabled.json));
  await until(
    "CDC flag version 2",
    () =>
      observed.some(
        (event) =>
          event.tenant_id === tenantId &&
          event.event_type === "flag.configuration_changed" &&
          event.aggregate_version === "2",
      ),
    90_000,
  );
  await delay(1000);
  const baseline = await heldCount();
  const heldIntent = await publishTask(tenantId);
  await until(
    "optional task held",
    async () => (await heldCount()) > baseline,
    30_000,
  );
  await until(
    "held task preserved in retry queue",
    () => claimHeldRetry(heldIntent),
    10_000,
  );
  assert.equal(
    (
      await notificationsRows(
        "SELECT status FROM deliveries WHERE tenant_id=$1 AND intent_id=$2",
        [tenantId, heldIntent],
      )
    ).length,
    0,
  );

  await producer.send({
    topic: "greenguard.platform.config.v1",
    messages: [
      {
        key: `${tenantId}:${version1.aggregate_id}`,
        value: JSON.stringify(version1),
      },
    ],
  });
  await delay(1000);
  const prior = await heldCount();
  const reorderedIntent = await publishTask(tenantId);
  await until(
    "reordered event ignored",
    async () => (await heldCount()) > prior,
    30_000,
  );
  await until(
    "reordered task preserved in retry queue",
    () => claimHeldRetry(reorderedIntent),
    10_000,
  );
  assert.equal(
    (
      await notificationsRows(
        "SELECT status FROM deliveries WHERE tenant_id=$1 AND intent_id=$2",
        [tenantId, reorderedIntent],
      )
    ).length,
    0,
  );
  console.log(
    `Stage 09f live E2E passed for isolated tenant ${tenantId}: audited flag v1/v2 -> CDC/Kafka -> send/hold; older event ignored`,
  );
} finally {
  await observer?.disconnect().catch(() => {});
  await producer?.disconnect().catch(() => {});
  await channel?.close().catch(() => {});
  await rabbit?.close().catch(() => {});
  for (const child of children.reverse()) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await delay(300);
  idp.close();
  rmSync(work, { recursive: true, force: true });
}
