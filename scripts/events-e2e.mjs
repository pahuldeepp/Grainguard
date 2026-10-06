import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  compose,
  composeArgs,
  broker,
  connectRequest,
  kafka,
  rawTopic,
  waitRunning,
} from "./events-lib.mjs";
import {
  bootstrapTenantOwnership,
  controlIncarnations,
  startPlacementAuthority,
  writeServiceRegistry,
} from "./placement-fixture.mjs";

// Host binaries keep this slice out of the Compose deployment topology. They
// connect using the same .env URLs as the Go integration tests.
process.loadEnvFile(".env");
const work = mkdtempSync(path.join(tmpdir(), "greenguard-events-e2e-"));
const children = new Set();
// Tenant placement for the binding consumer (set in the main block below).
let placementEnv = () => ({});
let placementAuthority;
const tenant = randomUUID();
const site = randomUUID();
const expected = [];
const timeout = 120_000;
// Loopback identity provider so the freshness gate is exercised through the
// real authenticated ingest endpoint.
const issuer = "https://e2e.greenguard.invalid/";
const audience = "greenguard-ingest";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwks = JSON.stringify({
  keys: [
    {
      ...publicKey.export({ format: "jwk" }),
      kid: "e2e",
      alg: "RS256",
      use: "sig",
    },
  ],
});
const idp = createServer((_, res) =>
  res.writeHead(200, { "Content-Type": "application/json" }).end(jwks),
);
await new Promise((resolve) => idp.listen(0, "127.0.0.1", resolve));
const jwksURL = `http://127.0.0.1:${idp.address().port}/jwks`;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token() {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", typ: "JWT", kid: "e2e" })}.${b64({
    iss: issuer,
    aud: audience,
    sub: "e2e-operator",
    tenant_id: tenant,
    roles: ["operator"],
    iat: now,
    exp: now + 3600,
  })}`;
  return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
}
async function postBody(device, request) {
  const response = await fetch(
    `http://127.0.0.1:18080/v1/devices/${device}/readings`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      body: request,
      signal: AbortSignal.timeout(5000),
    },
  );
  return {
    status: response.status,
    request,
    body: await response.json().catch(() => ({})),
  };
}
function postReading(device, sourceMessageID, temperature = 21.5) {
  const request = JSON.stringify({
    source_message_id: sourceMessageID,
    observed_at: new Date().toISOString(),
    temperature_c: temperature,
  });
  return postBody(device, request);
}
function sql(database, statement) {
  return compose(
    [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      `greenguard_${database}`,
    ],
    { input: statement },
  ).trim();
}
async function until(label, check) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}
function child(command, args, options = {}) {
  const p = spawn(command, args, options);
  children.add(p);
  p.once("exit", () => children.delete(p));
  return p;
}
async function stop(p, signal = "SIGTERM") {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const ended = new Promise((resolve) => p.once("exit", resolve));
  p.kill(signal);
  const timer = setTimeout(() => p.kill("SIGKILL"), 5000);
  await ended;
  clearTimeout(timer);
}
function build(service) {
  const binary = path.join(work, service);
  const result = spawnSync("go", ["build", "-o", binary, "."], {
    cwd: `services/${service}`,
    stdio: "inherit",
  });
  assert.equal(result.status, 0, `${service} build failed`);
  return binary;
}
function start(binary, port) {
  return child(binary, [], {
    stdio: "inherit",
    env: {
      ...process.env,
      HTTP_ADDR: `127.0.0.1:${port}`,
      KAFKA_BROKERS: process.env.KAFKA_BROKERS || "127.0.0.1:59092",
      EVENT_SCHEMA_DIR: path.resolve("contracts/events"),
      AUTH_ISSUER: issuer,
      AUTH_AUDIENCE: audience,
      AUTH_JWKS_URL: jwksURL,
      // Machine API keys are out of scope here; a lookup token inherited from
      // .env without CONTROL_PLANE_URL would abort startup.
      CONTROL_PLANE_URL: "",
      CONTROL_LOOKUP_TOKEN: "",
      ...placementEnv("telemetry-ingest", "telemetry", "TELEMETRY_DIRECT_URL"),
      // Checkpoints arrive every 30s; 45s keeps a live feed fresh and lets a stopped
      // connector turn it stale within about a minute.
      INGEST_BINDING_FEED_MAX_STALE: "45s",
      // The gate probes poll one device; keep the rate limiter out of that test.
      INGEST_DEVICE_RATE: "50",
      INGEST_DEVICE_BURST: "100",
      INGEST_TENANT_RATE: "50",
      INGEST_TENANT_BURST: "100",
    },
  });
}
function event(device = randomUUID(), version = 1) {
  const registered = version === 1;
  const e = {
    event_id: randomUUID(),
    event_type: registered ? "device.registered" : "device.status_changed",
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    tenant_id: tenant,
    aggregate_type: "device",
    aggregate_id: device,
    aggregate_version: String(version),
    correlation_id: randomUUID(),
    causation_id: randomUUID(),
    traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
    payload: {
      device_id: device,
      binding_version: String(version),
      status: registered ? "active" : "disabled",
    },
  };
  if (registered)
    Object.assign(e.payload, {
      serial_number: `E2E-${device}`,
      site_id: site,
      bin_id: null,
    });
  expected.push(e);
  return e;
}
function insert(events) {
  const statements = events.map(
    (e) => `INSERT INTO outbox_events
    (event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,correlation_id,causation_id,traceparent,payload)
    VALUES ('${e.event_id}','${tenant}','device','${e.aggregate_id}',${e.aggregate_version},'${e.event_type}',1,'${e.occurred_at}',
      '${e.correlation_id}','${e.causation_id}','${e.traceparent}','${JSON.stringify(e.payload)}');`,
  );
  sql(
    "inventory",
    `BEGIN; SET LOCAL session_replication_role = replica; SET LOCAL ROLE inventory_app; SELECT set_config('app.tenant_id','${tenant}',true); ${statements.join("\n")} COMMIT;`,
  );
}
function count(table) {
  return Number(
    sql(
      "telemetry",
      `SELECT count(*) FROM ${table} WHERE tenant_id='${tenant}';`,
    ),
  );
}
function inboxHas(eventID) {
  return (
    sql(
      "telemetry",
      `SELECT EXISTS (SELECT 1 FROM consumer_inbox WHERE tenant_id='${tenant}' AND event_id='${eventID}');`,
    ) === "t"
  );
}
async function replayDiagnostic(tail, consumer) {
  const detail = {
    tail_event_id: tail.event_id,
    expected_events: expected.length,
  };
  for (const [name, inspect] of Object.entries({
    outbox: () =>
      sql(
        "inventory",
        `SELECT count(*) FROM outbox_events WHERE event_id='${tail.event_id}';`,
      ),
    inbox: () => count("consumer_inbox"),
    bindings: () => count("device_bindings"),
    tail_inbox: () => inboxHas(tail.event_id),
    consumer_exit: () => ({
      code: consumer.exitCode,
      signal: consumer.signalCode,
    }),
    transformer_group: () =>
      kafka("consumer-groups", [
        "--group",
        "greenguard-cdc-transformer-v1",
        "--describe",
      ]),
    binding_group: () =>
      kafka("consumer-groups", [
        "--group",
        "telemetry-binding-consumer",
        "--describe",
      ]),
  })) {
    try {
      detail[name] = inspect();
    } catch (error) {
      detail[name] = error.message;
    }
  }
  try {
    const status = await connectRequest("/connectors/inventory-outbox/status");
    detail.inventory_connector = {
      connector: status.connector.state,
      tasks: status.tasks.map(({ state, trace }) => ({ state, trace })),
    };
  } catch (error) {
    detail.inventory_connector = error.message;
  }
  console.error("replay drain diagnostic", detail);
}
async function ready(port) {
  await until(`service readiness ${port}`, async () => {
    try {
      return (
        await fetch(`http://127.0.0.1:${port}/readyz`, {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {
      return false;
    }
  });
}
async function quarantineProbe(marker, action) {
  const offset = kafka("get-offsets", [
    "--topic",
    "greenguard.quarantine.v1",
    "--time",
    "-1",
  ])
    .trim()
    .split(":")
    .at(-1);
  const reader = child(
    "docker",
    [
      ...composeArgs,
      "exec",
      "-T",
      "kafka",
      "/opt/kafka/bin/kafka-console-consumer.sh",
      "--bootstrap-server",
      broker,
      "--topic",
      "greenguard.quarantine.v1",
      "--partition",
      "0",
      "--offset",
      offset,
      "--timeout-ms",
      String(timeout),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let found = false;
  const lines = createInterface({ input: reader.stdout });
  lines.on("line", (line) => {
    const q = JSON.parse(line);
    if (Buffer.from(q.raw_base64, "base64").toString() === marker) {
      assert.equal(q.source_topic, rawTopic("inventory"));
      assert.equal(q.reason, "bad_envelope");
      found = true;
    }
  });
  try {
    await action();
    await until("poison quarantine", () => found);
  } finally {
    lines.close();
    await stop(reader);
  }
}
async function lockStream(device) {
  const locker = child(
    "docker",
    [
      ...composeArgs,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "greenguard_telemetry",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let held = false;
  locker.stdout.on("data", (data) => {
    if (data.toString().includes("held")) held = true;
  });
  locker.stdin.write(
    `BEGIN; SELECT 1 FROM device_streams WHERE tenant_id='${tenant}' AND device_id='${device}' FOR UPDATE; SELECT 'held';\n`,
  );
  await until("stream lock acquired", () => held);
  return locker;
}

// Dev topics keep history from earlier runs whose telemetry state the migration
// tests have since rolled back; replaying it would (correctly) halt the consumer on
// a version gap. The acceptance run therefore starts both groups at the log end.
async function startAtLogEnd() {
  const groups = [
    [
      "greenguard-cdc-transformer-v1",
      [rawTopic("inventory"), rawTopic("telemetry")],
    ],
    ["telemetry-binding-consumer", ["greenguard.inventory.device.v1"]],
  ];
  for (const [group, topics] of groups) {
    await until(`reset ${group} to log end`, () => {
      try {
        kafka("consumer-groups", [
          "--group",
          group,
          "--reset-offsets",
          "--to-latest",
          "--execute",
          ...topics.flatMap((topic) => ["--topic", topic]),
        ]);
        return true;
      } catch {
        return false; // a stale member from a killed run holds the group until its session expires
      }
    });
  }
}

try {
  const incarnations = await controlIncarnations();
  await bootstrapTenantOwnership([tenant], ["telemetry"], incarnations);
  placementAuthority = await startPlacementAuthority(incarnations);
  placementAuthority.add(tenant);
  placementEnv = (service, database, directUrlEnv) => ({
    SHARD_REGISTRY_FILE: writeServiceRegistry({
      dir: path.join(work, "registry"),
      service,
      database,
      directUrl: process.env[directUrlEnv],
      incarnations,
    }),
    SHARD_LOCAL_LOOPBACK: "true",
    CONTROL_PLANE_URL: placementAuthority.url,
    CONTROL_LOOKUP_TOKEN: placementAuthority.token,
  });
  await startAtLogEnd();
  const transformerBinary = build("cdc-transformer");
  const consumerBinary = build("telemetry-ingest");
  start(transformerBinary, 18081);
  let consumer = start(consumerBinary, 18080);
  await ready(18081);
  await ready(18080);
  const first = event();
  insert([first]);
  await until(
    "inventory outbox to binding",
    () => count("device_bindings") === 1,
  );
  assert.equal(count("consumer_inbox"), 1);
  console.log(
    "PASS: committed inventory outbox -> raw -> transformer -> canonical -> binding",
  );

  const poison = JSON.stringify({ e2e_poison: randomUUID() });
  await quarantineProbe(poison, async () => {
    compose(
      [
        "exec",
        "-T",
        "kafka",
        "/opt/kafka/bin/kafka-console-producer.sh",
        "--bootstrap-server",
        broker,
        "--topic",
        rawTopic("inventory"),
      ],
      { input: `${poison}\n` },
    );
    insert([event()]);
    await until(
      "good event after poison",
      () => count("device_bindings") === 2,
    );
  });
  console.log(
    "PASS: poison preserved in quarantine; following good event applied",
  );

  const locker = await lockStream(first.aggregate_id);
  insert([
    event(first.aggregate_id, 2),
    ...Array.from({ length: 24 }, () => event()),
  ]);
  await until(
    "consumer blocked mid-stream",
    () =>
      Number(
        sql(
          "telemetry",
          "SELECT count(*) FROM pg_stat_activity WHERE usename='telemetry_app' AND wait_event_type='Lock' AND query LIKE '%device_streams%';",
        ),
      ) > 0,
  );
  await stop(consumer, "SIGKILL");
  locker.stdin.end("COMMIT;\n");
  await until("stream locker exited", () => locker.exitCode !== null);
  consumer = start(consumerBinary, 18080);
  await ready(18080);
  await until(
    "restart drains every event",
    () => count("consumer_inbox") === expected.length,
  );
  assert.equal(count("device_bindings"), 26);
  assert.equal(count("device_streams"), 26);
  assert.equal(
    sql(
      "telemetry",
      `SELECT status || ':' || inventory_version FROM device_bindings WHERE tenant_id='${tenant}' AND device_id='${first.aggregate_id}';`,
    ),
    "disabled:2",
  );
  // Duplicate raw delivery must preserve both inbox and effects after restart.
  // One producer session sends the whole replay, in order.
  const replayLines = expected.map((e) =>
    JSON.stringify({ op: "c", source: { table: "outbox_events" }, after: e }),
  );
  compose(
    [
      "exec",
      "-T",
      "kafka",
      "/opt/kafka/bin/kafka-console-producer.sh",
      "--bootstrap-server",
      broker,
      "--topic",
      rawTopic("inventory"),
    ],
    { input: `${replayLines.join("\n")}\n` },
  );
  // A new trailing event proves progress beyond every replayed raw record.
  const tail = event();
  insert([tail]);
  try {
    await until("replay drain", () => inboxHas(tail.event_id));
  } catch (error) {
    await replayDiagnostic(tail, consumer);
    throw error;
  }
  assert.equal(count("device_bindings"), 27);
  await until("consumer group drains all canonical partitions", () => {
    const rows = kafka("consumer-groups", [
      "--group",
      "telemetry-binding-consumer",
      "--describe",
    ])
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns[1] === "greenguard.inventory.device.v1");
    return rows.length === 6 && rows.every((columns) => columns[5] === "0");
  });
  assert.equal(count("consumer_inbox"), expected.length);
  const ids = expected.map((e) => `'${e.event_id}'`).join(",");
  assert.equal(
    Number(
      sql(
        "telemetry",
        `SELECT count(*) FROM consumer_inbox WHERE tenant_id='${tenant}' AND event_id IN (${ids});`,
      ),
    ),
    expected.length,
  );
  assert.equal(
    sql(
      "telemetry",
      `SELECT sum(last_version) FROM device_streams WHERE tenant_id='${tenant}';`,
    ),
    "0",
  );
  console.log(
    "PASS: SIGKILL mid-stream, restart and replay have exactly one effect per event",
  );

  await until(
    "source heartbeat covers all six partitions",
    () =>
      Number(
        sql(
          "telemetry",
          "SELECT count(*) FROM binding_feed_checkpoints WHERE partition_count=6 AND source_time > clock_timestamp()-interval '90 seconds';",
        ),
      ) === 6,
  );
  console.log(
    "PASS: source heartbeat traversed idle feed and persisted six partition checkpoints",
  );

  // Freshness gate: accepted while fresh, 503 once the source stops, receipt replay
  // still answered while stale, and admission resumes when checkpoints return.
  const accepted = await postReading(
    tail.aggregate_id,
    `e2e-fresh-${randomUUID()}`,
  );
  assert.equal(accepted.status, 202, JSON.stringify(accepted));
  const retryID = `e2e-retry-${randomUUID()}`;
  const original = await postReading(tail.aggregate_id, retryID, 22.25);
  assert.equal(original.status, 202, JSON.stringify(original));
  compose(["stop", "connect"]);
  let stale;
  try {
    // Poll read-only progress, then exercise the real admission gate once.
    // Reusing a successful receipt would bypass that gate; unique writes leak rows.
    await until(
      "feed exceeds the configured 45-second stale bound",
      async () => {
        const response = await fetch("http://127.0.0.1:18080/metrics", {
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        const metrics = await response.text();
        const age = /^binding_feed_age_seconds (.+)$/m.exec(metrics);
        assert.ok(age, "binding feed age metric missing");
        return Number(age[1]) > 45;
      },
    );
    stale = await postReading(tail.aggregate_id, `e2e-stale-${randomUUID()}`);
    assert.equal(stale.status, 503, JSON.stringify(stale));
    assert.equal(stale.body.code, "binding_feed_stale", JSON.stringify(stale));
    // An identical retry resolves through its stored receipt, never the gate.
    const replay = await postBody(tail.aggregate_id, original.request);
    assert.equal(replay.status, 202, JSON.stringify(replay));
    assert.equal(replay.body.reading_id, original.body.reading_id);
    assert.equal(replay.body.event_id, original.body.event_id);
  } finally {
    compose(["up", "-d", "--wait", "connect"]);
  }
  console.log(
    "PASS: stale feed -> 503 binding_feed_stale; identical retry answered from its receipt",
  );
  await waitRunning("inventory-outbox");
  await until("gate recovers after checkpoints resume", async () => {
    const recovered = await postReading(
      tail.aggregate_id,
      `e2e-recovered-${randomUUID()}`,
    );
    return recovered.status === 202;
  });
  console.log(
    "PASS: freshness gate admitted new readings again after the feed recovered",
  );
} finally {
  idp.close();
  placementAuthority?.close();
  await Promise.all([...children].map((p) => stop(p)));
  rmSync(work, { recursive: true, force: true });
}
