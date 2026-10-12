// Opt-in two-tenant provisioning and compensation path across real Postgres,
// Kafka, CDC, MQTT and independently restartable services.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import kafkaJs from "kafkajs";
import pg from "pg";
import {
  bootstrapTenantOwnership,
  controlIncarnations,
  localShardSelection,
  startPlacementAuthority,
  writeServiceRegistry,
} from "./placement-fixture.mjs";
import { composeContainerName } from "./ci-compose-project.mjs";

process.loadEnvFile(".env");
const { Kafka, logLevel } = kafkaJs;
const broker = "127.0.0.1:59092";
const mqttBroker = "tcp://127.0.0.1:51883";
const tmp = mkdtempSync(path.join(tmpdir(), "greenguard-stage07-"));
const children = [];
const logs = new Map();
const id = randomUUID().slice(0, 8);
const tenants = [randomUUID(), randomUUID()];
const items = tenants.map((tenant) => ({
  tenant,
  site: randomUUID(),
  device: randomUUID(),
  asset: randomUUID(),
  serial: `stage07-${id}-${tenant.slice(0, 8)}`,
  secret: randomBytes(32),
}));
const compensate = {
  tenant: tenants[0],
  site: items[0].site,
  device: randomUUID(),
  asset: randomUUID(),
  inventoryAsset: randomUUID(),
  serial: `stage07-${id}-compensate`,
  secret: randomBytes(32),
};
// Gate items: `acked` items have an MQTT fixture key; the others never receive a
// hardware acknowledgement and exercise timeout compensation and redrive.
const gate = Object.fromEntries(
  [
    ["kill", 1, true],
    ["outage", 0, true],
    ["broker", 1, true],
    ["lease", 0, true],
    ["race", 0, true],
    ["timeout", 0, false],
    ["redrive", 1, false],
  ].map(([name, t, acked]) => [
    name,
    {
      name,
      acked,
      tenant: tenants[t],
      site: items[t].site,
      device: randomUUID(),
      asset: randomUUID(),
      serial: `stage07-${id}-${name}`,
      secret: randomBytes(32),
    },
  ]),
);
const procs = {};
const bins = {};
const sagaGroup = `stage07-saga-${id}`;
const issuer = `https://stage07-${id}.greenguard.invalid/`;
const audience = "greenguard-saga";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwks = JSON.stringify({
  keys: [
    {
      ...publicKey.export({ format: "jwk" }),
      kid: id,
      alg: "RS256",
      use: "sig",
    },
  ],
});
const idp = createServer((_req, res) =>
  res.writeHead(200, { "Content-Type": "application/json" }).end(jwks),
);
let idpStarted = false;
const kafka = new Kafka({
  clientId: `stage07-e2e-${id}`,
  brokers: [broker],
  logLevel: logLevel.ERROR,
});
let admin;
// Tenant placement: services resolve ownership through a private shard registry and a
// placement authority, exactly as in a sharded deployment (set in main()).
let placementEnv = () => ({});
let placementAuthority;

function buildGo(module, target, name) {
  const output = path.join(tmp, name);
  const result = spawnSync("go", ["build", "-o", output, target], {
    cwd: module,
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.equal(
    result.status,
    0,
    `${name} build: ${result.stderr?.slice(-1800)}`,
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
    log = (log + chunk.toString()).slice(-5000);
    logs.set(name, log);
  });
  p.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM")
      logs.set(name, `${log}\nexit=${code} signal=${signal}`);
  });
  children.push(p);
  return p;
}
async function stop(p) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const closed = new Promise((resolve) => p.once("close", resolve));
  p.kill("SIGTERM");
  await Promise.race([closed, delay(7000).then(() => p.kill("SIGKILL"))]);
}
async function waitFor(predicate, label, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(300);
  }
  throw new Error(
    `${label} timed out: ${last?.message ?? "no matching state"}\n${[...logs].map(([name, log]) => `${name}: ${log.slice(-1000)}`).join("\n")}`,
  );
}
async function scoped(url, tenant, work, fixture = false) {
  // Fixture writes are seeded as the PostgreSQL superuser with the tenant-ownership
  // row fence bypassed for that transaction, then switch back to the service role so
  // RLS still applies. The services under test keep the fence enabled.
  const target = new URL(url);
  let connectionString = url;
  if (fixture) {
    const admin = new URL(process.env.POSTGRES_ADMIN_URL);
    admin.pathname = target.pathname;
    connectionString = admin.toString();
  }
  const db = new pg.Client({ connectionString });
  await db.connect();
  try {
    await db.query("BEGIN");
    if (fixture) {
      await db.query("SET LOCAL session_replication_role = replica");
      await db.query(`SET LOCAL ROLE "${decodeURIComponent(target.username)}"`);
    }
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}
const fixtureScoped = (url, tenant, work) => scoped(url, tenant, work, true);
async function seed() {
  for (const item of items) {
    await fixtureScoped(
      process.env.INVENTORY_PROJECTOR_DIRECT_URL,
      item.tenant,
      (db) =>
        db.query(
          "INSERT INTO tenants(tenant_id,name) VALUES($1,'Stage07 E2E')",
          [item.tenant],
        ),
    );
    await fixtureScoped(
      process.env.INVENTORY_DIRECT_URL,
      item.tenant,
      async (db) => {
        await db.query(
          "INSERT INTO sites(tenant_id,site_id,name) VALUES($1,$2,'Stage07 Site')",
          [item.tenant, item.site],
        );
        await db.query(
          `INSERT INTO devices(tenant_id,device_id,site_id,serial_number,status,asset_id)
        VALUES($1,$2,$3,$4,'provisioning',$5)`,
          [item.tenant, item.device, item.site, item.serial, item.asset],
        );
      },
    );
    await fixtureScoped(process.env.HARDWARE_DIRECT_URL, item.tenant, (db) =>
      db.query(
        `
      INSERT INTO hardware_assets(tenant_id,asset_id,serial_number,mqtt_ack_secret)
      VALUES($1,$2,$3,$4)`,
        [item.tenant, item.asset, item.serial, item.secret],
      ),
    );
  }
  await fixtureScoped(
    process.env.INVENTORY_DIRECT_URL,
    compensate.tenant,
    (db) =>
      db.query(
        `
    INSERT INTO devices(tenant_id,device_id,site_id,serial_number,status,asset_id)
    VALUES($1,$2,$3,$4,'provisioning',$5)`,
        [
          compensate.tenant,
          compensate.device,
          compensate.site,
          compensate.serial,
          compensate.inventoryAsset,
        ],
      ),
  );
  await fixtureScoped(
    process.env.HARDWARE_DIRECT_URL,
    compensate.tenant,
    (db) =>
      db.query(
        `
    INSERT INTO hardware_assets(tenant_id,asset_id,serial_number,mqtt_ack_secret)
    VALUES($1,$2,$3,$4)`,
        [
          compensate.tenant,
          compensate.asset,
          compensate.serial,
          compensate.secret,
        ],
      ),
  );
  for (const item of Object.values(gate)) {
    await fixtureScoped(process.env.INVENTORY_DIRECT_URL, item.tenant, (db) =>
      db.query(
        `INSERT INTO devices(tenant_id,device_id,site_id,serial_number,status,asset_id)
        VALUES($1,$2,$3,$4,'provisioning',$5)`,
        [item.tenant, item.device, item.site, item.serial, item.asset],
      ),
    );
    await fixtureScoped(process.env.HARDWARE_DIRECT_URL, item.tenant, (db) =>
      db.query(
        `INSERT INTO hardware_assets(tenant_id,asset_id,serial_number,mqtt_ack_secret)
        VALUES($1,$2,$3,$4)`,
        [item.tenant, item.asset, item.serial, item.secret],
      ),
    );
  }
  const acked = Object.values(gate).filter((item) => item.acked);
  const fixtures = [...items, compensate, ...acked].map((item) => ({
    tenant_id: item.tenant,
    asset_id: item.asset,
    secret_hex: item.secret.toString("hex"),
  }));
  const fixtureFile = path.join(tmp, "mqtt-fixtures.json");
  writeFileSync(fixtureFile, JSON.stringify(fixtures), { mode: 0o600 });
  return fixtureFile;
}
async function seedOffsets() {
  admin = kafka.admin();
  await admin.connect();
  const groups = [
    [
      `stage07-cdc-${id}`,
      [
        "greenguard.raw.inventory.outbox",
        "greenguard.raw.telemetry.outbox",
        "greenguard.raw.risk.outbox",
        "greenguard.raw.alerts.outbox",
      ],
    ],
    [sagaGroup, ["greenguard.saga.results.v1"]],
    ["greenguard-inventory-saga-v1", ["greenguard.saga.commands.v1"]],
    ["telemetry-saga-binding-v1", ["greenguard.saga.commands.v1"]],
    // Skip inventory history left by earlier suites: a status change for a
    // device this database never registered is a fail-closed stop by design.
    ["telemetry-binding-consumer", ["greenguard.inventory.device.v1"]],
    ["greenguard.hardware.v1", ["greenguard.saga.commands.v1"]],
  ];
  for (const [groupId, topics] of groups) {
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
    }
  }
}
function jwt(tenant) {
  const b64 = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", typ: "JWT", kid: id })}.${b64({
    iss: issuer,
    aud: audience,
    sub: "stage07-operator",
    tenant_id: tenant,
    roles: ["admin"],
    iat: now,
    exp: now + 3600,
  })}`;
  return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
}
async function request(tenant, route, method = "GET", body, extraHeaders) {
  const response = await fetch(`http://127.0.0.1:18092${route}`, {
    method,
    headers: {
      ...extraHeaders,
      Authorization: `Bearer ${jwt(tenant)}`,
      ...(body && {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      }),
    },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}
async function status(item, sagaID) {
  const response = await request(item.tenant, `/v1/provisioning/${sagaID}`);
  assert.equal(response.status, 200, JSON.stringify(response));
  return response.body.saga;
}
async function main() {
  const connector = await fetch(
    "http://127.0.0.1:58083/connectors/inventory-outbox/status",
    { signal: AbortSignal.timeout(5000) },
  ).then((r) => r.json());
  assert.equal(
    connector.connector.state,
    "RUNNING",
    "inventory CDC connector must run",
  );
  assert.ok(connector.tasks.every((task) => task.state === "RUNNING"));
  const incarnations = await controlIncarnations();
  await bootstrapTenantOwnership(
    tenants,
    ["inventory", "telemetry", "sagas", "hardware"],
    incarnations,
  );
  placementAuthority = await startPlacementAuthority(incarnations);
  placementAuthority.add(...tenants);
  const registryDir = path.join(tmp, "registry");
  placementEnv = (service, database, directUrlEnv) => ({
    SHARD_REGISTRY_FILE: writeServiceRegistry({
      dir: registryDir,
      service,
      database,
      directUrl: process.env[directUrlEnv],
      incarnations,
    }),
    ...localShardSelection(),
    CONTROL_PLANE_URL: placementAuthority.url,
    CONTROL_LOOKUP_TOKEN: placementAuthority.token,
  });
  const fixtureFile = await seed();
  await seedOffsets();
  await new Promise((resolve) => idp.listen(18192, "127.0.0.1", resolve));
  idpStarted = true;
  bins.saga = buildGo(
    "services/saga-orchestrator",
    "./cmd/worker",
    "saga-worker",
  );
  const sagaAPI = buildGo(
    "services/saga-orchestrator",
    "./cmd/api",
    "saga-api",
  );
  bins.hardware = buildGo(
    "services/hardware-service",
    "./cmd/worker",
    "hardware-worker",
  );
  const mqttFixture = buildGo(
    "services/hardware-service",
    "./cmd/mqtt-fixture",
    "mqtt-fixture",
  );
  bins.telemetry = buildGo(
    "services/telemetry-ingest",
    ".",
    "telemetry-ingest",
  );
  const cdc = buildGo("services/cdc-transformer", ".", "cdc-transformer");
  start("mqtt-fixture", mqttFixture, [], "services/hardware-service", {
    MQTT_BROKER_URL: mqttBroker,
    MQTT_FIXTURES_FILE: fixtureFile,
  });
  startParticipant("hardware");
  startParticipant("inventory");
  startParticipant("telemetry");
  start("cdc", cdc, [], "services/cdc-transformer", {
    KAFKA_BROKERS: broker,
    KAFKA_GROUP_ID: `stage07-cdc-${id}`,
    EVENT_SCHEMA_DIR: path.resolve("contracts/events"),
    HTTP_ADDR: "127.0.0.1:18098",
  });
  start("saga-api", sagaAPI, [], "services/saga-orchestrator", {
    SAGA_API_ADDR: "127.0.0.1:18092",
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: "http://127.0.0.1:18192/keys",
    ...placementEnv("saga-orchestrator", "sagas", "SAGA_DIRECT_URL"),
  });
  const orchestrator = startSaga("saga-worker");
  await waitFor(
    async () =>
      (await fetch("http://127.0.0.1:18092/healthz").catch(() => null))
        ?.status === 204,
    "saga API health",
    30_000,
  );
  const starts = [];
  // Stage 07d: tenant 1's start carries a caller trace (unsampled, to prove the
  // flag survives); every command, result and activation event must reuse it.
  const startTrace = `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-00`;
  const compensationTrace = `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
  for (const item of [...items, compensate]) {
    const response = await request(
      item.tenant,
      "/v1/provisioning",
      "POST",
      { device_id: item.device, asset_id: item.asset },
      item === items[0]
        ? { traceparent: startTrace }
        : item === compensate
          ? { traceparent: compensationTrace }
          : undefined,
    );
    assert.equal(response.status, 202, JSON.stringify(response));
    starts.push(response.body);
  }
  // Require a broker-acknowledged command and a nonterminal saga before the
  // coordinator is stopped; this is a real mid-flight restart boundary.
  await waitFor(
    async () =>
      scoped(process.env.SAGA_DIRECT_URL, tenants[0], async (db) => {
        const rows = await db.query(
          `SELECT s.state, count(o.command_id)::int AS published
      FROM provisioning_sagas s JOIN saga_command_outbox o
      ON o.tenant_id=s.tenant_id AND o.saga_id=s.saga_id
      WHERE s.tenant_id=$1 AND s.saga_id=$2 AND o.published_at IS NOT NULL
      GROUP BY s.state`,
          [tenants[0], starts[0].SagaID],
        );
        return (
          rows.rows[0]?.published > 0 &&
          !["active", "compensated", "repair_required"].includes(
            rows.rows[0].state,
          )
        );
      }),
    "published command with nonterminal saga",
    30_000,
  );
  await stop(orchestrator);
  startSaga("saga-worker-restarted");
  for (let i = 0; i < 2; i++) {
    const active = await waitFor(
      async () => {
        const state = await status(items[i], starts[i].SagaID);
        return state.State === "active" && state;
      },
      `tenant ${i + 1} active`,
      120_000,
    );
    assert.ok(active.Version >= 5);
  }
  await assertTraceCrossesSaga(items[0], starts[0].SagaID, startTrace);
  const denied = await request(
    tenants[1],
    `/v1/provisioning/${starts[0].SagaID}`,
  );
  assert.equal(denied.status, 404, "tenant B must not read tenant A saga");
  // Replay the original participant result through Kafka. Both deliveries
  // must hit the durable inbox and leave the promoted saga version unchanged.
  const beforeReplay = await status(items[0], starts[0].SagaID);
  const replay = await scoped(
    process.env.SAGA_DIRECT_URL,
    tenants[0],
    async (db) => {
      const rows = await db.query(
        `SELECT i.result_id, i.command_id, i.outcome,
      o.step, o.saga_version, o.fencing_token FROM saga_result_inbox i
      JOIN saga_command_outbox o ON o.tenant_id=i.tenant_id AND o.command_id=i.command_id
      WHERE i.tenant_id=$1 AND i.saga_id=$2 AND o.step='asset.reserve' LIMIT 1`,
        [tenants[0], starts[0].SagaID],
      );
      return rows.rows[0];
    },
  );
  assert.ok(replay?.result_id, "reserve result receipt must exist");
  const replayProducer = kafka.producer({ allowAutoTopicCreation: false });
  await replayProducer.connect();
  try {
    const value = JSON.stringify({
      tenant_id: tenants[0],
      saga_id: starts[0].SagaID,
      command_id: replay.command_id,
      result_id: replay.result_id,
      step: replay.step,
      saga_version: Number(replay.saga_version),
      fencing_token: Number(replay.fencing_token),
      outcome: replay.outcome,
    });
    await replayProducer.send({
      topic: "greenguard.saga.results.v1",
      acks: -1,
      messages: [1, 2].map(() => ({
        key: `${tenants[0]}:${starts[0].SagaID}`,
        value,
      })),
    });
  } finally {
    await replayProducer.disconnect();
  }
  await delay(1500);
  const afterReplay = await status(items[0], starts[0].SagaID);
  assert.equal(
    afterReplay.Version,
    beforeReplay.Version,
    "duplicate Kafka results must not advance the saga",
  );
  await waitFor(
    async () => {
      const state = await status(compensate, starts[2].SagaID);
      return state.State === "compensated" && state;
    },
    "inventory rejection and hardware release",
    120_000,
  );
  await assertCompensationTrace(
    compensate,
    starts[2].SagaID,
    compensationTrace,
  );
  const released = await scoped(
    process.env.HARDWARE_DIRECT_URL,
    compensate.tenant,
    async (db) => {
      const rows = await db.query(
        "SELECT state,owner_saga_id FROM hardware_assets WHERE tenant_id=$1 AND asset_id=$2",
        [compensate.tenant, compensate.asset],
      );
      return rows.rows[0];
    },
  );
  assert.deepEqual(released, { state: "available", owner_saga_id: null });
  console.log(
    "Stage07 two-tenant active + MQTT ack + coordinator restart + duplicate result + inventory rejection/asset release: PASS",
  );
  if (process.env.STAGE07_TRACE_ONLY === "1") return;
  await runGate();
}

function startSaga(name, current = true) {
  const p = start(name, bins.saga, [], "services/saga-orchestrator", {
    KAFKA_BROKERS: broker,
    SAGA_RESULT_GROUP: sagaGroup,
    SAGA_LEASE_TTL_SECONDS: "3",
    SAGA_WORKER_ID: `stage07-${id}-${name}-${Date.now()}`,
    ...placementEnv("saga-orchestrator", "sagas", "SAGA_DIRECT_URL"),
  });
  if (current) procs.saga = p;
  return p;
}
const participantArgs = {
  hardware: () => [
    bins.hardware,
    [],
    "services/hardware-service",
    {
      KAFKA_BROKERS: broker,
      MQTT_BROKER_URL: mqttBroker,
      MQTT_CLIENT_ID: `stage07-${id}-hardware`,
      ...placementEnv("hardware-service", "hardware", "HARDWARE_DIRECT_URL"),
    },
  ],
  inventory: () => [
    process.execPath,
    ["dist/saga/main.js"],
    "services/device-service",
    {
      KAFKA_BROKERS: broker,
      ...placementEnv("device-service", "inventory", "INVENTORY_DIRECT_URL"),
    },
  ],
  telemetry: () => [
    bins.telemetry,
    [],
    "services/telemetry-ingest",
    {
      KAFKA_BROKERS: broker,
      SAGA_BINDING_ENABLED: "1",
      EVENT_SCHEMA_DIR: path.resolve("contracts/events"),
      HTTP_ADDR: "127.0.0.1:18097",
      ...placementEnv("telemetry-ingest", "telemetry", "TELEMETRY_DIRECT_URL"),
    },
  ],
};
function startParticipant(name) {
  const [command, args, cwd, env] = participantArgs[name]();
  procs[name] = start(name, command, args, cwd, env);
  return procs[name];
}
const exited = (p) => p.exitCode !== null || p.signalCode !== null;
async function kill9(p) {
  if (exited(p)) return;
  const closed = new Promise((resolve) => p.once("close", resolve));
  p.kill("SIGKILL");
  await closed;
}
async function restart(name) {
  if (name === "saga") startSaga(`saga-${Date.now()}`);
  else startParticipant(name);
}
async function ensureRunning(report) {
  for (const name of ["saga", "hardware", "inventory", "telemetry"]) {
    if (exited(procs[name])) {
      report.push(name);
      await restart(name);
    }
  }
}
// Includes a deadline UPDATE that simulates a stalled saga, so it bypasses the row fence.
const sagaDb = (tenant, sql, args) =>
  fixtureScoped(process.env.SAGA_DIRECT_URL, tenant, (db) =>
    db.query(sql, args),
  );
async function provision(item, device = item.device) {
  const response = await request(item.tenant, "/v1/provisioning", "POST", {
    device_id: device,
    asset_id: item.asset,
  });
  assert.equal(response.status, 202, JSON.stringify(response));
  return response.body.SagaID;
}
async function waitState(item, sagaID, states, label, timeoutMs = 120_000) {
  const wanted = [states].flat();
  return waitFor(
    async () => {
      const state = await status(item, sagaID);
      return wanted.includes(state.State) && state;
    },
    label,
    timeoutMs,
  );
}
async function forceDeadline(item, sagaID) {
  await sagaDb(
    item.tenant,
    "UPDATE provisioning_sagas SET deadline_at=now()-interval '1 second' WHERE tenant_id=$1 AND saga_id=$2",
    [item.tenant, sagaID],
  );
}
// One trace crosses saga API -> worker -> Kafka -> participants -> results ->
// the final activation event (ADR-0004, Saga section).
async function assertTraceCrossesSaga(item, sagaID, trace) {
  const args = [item.tenant, sagaID];
  const rows = async (url, sql, a = args) =>
    (await scoped(url, item.tenant, (db) => db.query(sql, a))).rows;
  const traces = {
    saga: await rows(
      process.env.SAGA_DIRECT_URL,
      "SELECT traceparent t, trace_origin o FROM provisioning_sagas WHERE tenant_id=$1 AND saga_id=$2",
    ),
    commands: await rows(
      process.env.SAGA_DIRECT_URL,
      "SELECT step, traceparent t FROM saga_command_outbox WHERE tenant_id=$1 AND saga_id=$2 AND published_at IS NOT NULL",
    ),
    hardwareResults: await rows(
      process.env.HARDWARE_DIRECT_URL,
      "SELECT step, traceparent t FROM hardware_result_outbox WHERE tenant_id=$1 AND saga_id=$2",
    ),
    inventoryResults: await rows(
      process.env.INVENTORY_DIRECT_URL,
      "SELECT step, traceparent t FROM inventory_saga_result_outbox WHERE tenant_id=$1 AND saga_id=$2",
    ),
    bindingResults: await rows(
      process.env.TELEMETRY_DIRECT_URL,
      "SELECT 'binding.await' step, traceparent t FROM saga_binding_requests WHERE tenant_id=$1 AND saga_id=$2",
    ),
    activationEvents: await rows(
      process.env.INVENTORY_MIGRATION_URL,
      "SELECT event_type step, traceparent t FROM outbox_events WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='device.registered'",
      [item.tenant, item.device],
    ),
  };
  assert.deepEqual(traces.saga, [{ t: trace, o: "propagated" }]);
  for (const [name, list] of Object.entries(traces)) {
    assert.ok(list.length > 0, `${name} must exist`);
    for (const row of list)
      assert.equal(row.t, trace, `${name} ${row.step ?? ""} lost the trace`);
  }
  assert.ok(traces.commands.some((c) => c.step === "asset.reserve"));
  console.log(
    `Stage07d trace ${trace.slice(3, 35)} on ${traces.commands.length} commands, ${traces.hardwareResults.length + traces.inventoryResults.length + traces.bindingResults.length} results, ${traces.activationEvents.length} activation event: PASS`,
  );
}

async function assertCompensationTrace(item, sagaID, trace) {
  const args = [item.tenant, sagaID];
  const rows = async (url, sql) =>
    (await scoped(url, item.tenant, (db) => db.query(sql, args))).rows;
  const saga = await rows(
    process.env.SAGA_DIRECT_URL,
    "SELECT traceparent t, trace_origin o FROM provisioning_sagas WHERE tenant_id=$1 AND saga_id=$2",
  );
  assert.deepEqual(saga, [{ t: trace, o: "propagated" }]);
  const commands = await rows(
    process.env.SAGA_DIRECT_URL,
    "SELECT step, traceparent t FROM saga_command_outbox WHERE tenant_id=$1 AND saga_id=$2 AND published_at IS NOT NULL",
  );
  const hardwareResults = await rows(
    process.env.HARDWARE_DIRECT_URL,
    "SELECT step, traceparent t FROM hardware_result_outbox WHERE tenant_id=$1 AND saga_id=$2",
  );
  const inventoryResults = await rows(
    process.env.INVENTORY_DIRECT_URL,
    "SELECT step, outcome, traceparent t FROM inventory_saga_result_outbox WHERE tenant_id=$1 AND saga_id=$2",
  );
  assert.ok(
    commands.some((row) => row.step === "asset.release"),
    "compensation command must publish",
  );
  assert.ok(
    hardwareResults.some((row) => row.step === "asset.release"),
    "compensation result must publish",
  );
  assert.ok(
    inventoryResults.some(
      (row) => row.step === "inventory.activate" && row.outcome === "rejected",
    ),
    "inventory rejection must publish",
  );
  for (const [name, list] of Object.entries({
    commands,
    hardwareResults,
    inventoryResults,
  })) {
    assert.ok(list.length > 0, `${name} must exist`);
    for (const row of list)
      assert.equal(row.t, trace, `${name} ${row.step} lost the trace`);
  }
  console.log(
    `Stage07d compensation trace ${trace.slice(3, 35)} on ${commands.length} commands, ${hardwareResults.length + inventoryResults.length} results: PASS`,
  );
}
async function counts(url, tenant, sql, args) {
  const result = await scoped(url, tenant, (db) => db.query(sql, args));
  return Object.fromEntries(result.rows.map((r) => [r.k, r.n]));
}
// Exactly one command, receipt and effect per step, across all four owners.
async function assertNoDuplicates(item, sagaID, device = item.device) {
  const args = [item.tenant, sagaID];
  const summary = {
    commands: await counts(
      process.env.SAGA_DIRECT_URL,
      item.tenant,
      "SELECT step k,count(*)::int n FROM saga_command_outbox WHERE tenant_id=$1 AND saga_id=$2 GROUP BY step",
      args,
    ),
    results: await counts(
      process.env.SAGA_DIRECT_URL,
      item.tenant,
      "SELECT 'all' k,count(*)::int n FROM saga_result_inbox WHERE tenant_id=$1 AND saga_id=$2",
      args,
    ),
    hardware: await counts(
      process.env.HARDWARE_DIRECT_URL,
      item.tenant,
      "SELECT step k,count(*)::int n FROM hardware_command_receipts WHERE tenant_id=$1 AND saga_id=$2 GROUP BY step",
      args,
    ),
    inventory: await counts(
      process.env.INVENTORY_DIRECT_URL,
      item.tenant,
      "SELECT step k,count(*)::int n FROM inventory_saga_receipts WHERE tenant_id=$1 AND saga_id=$2 GROUP BY step",
      args,
    ),
    registeredEvents: await counts(
      process.env.INVENTORY_MIGRATION_URL,
      item.tenant,
      "SELECT event_type k,count(*)::int n FROM outbox_events WHERE tenant_id=$1 AND aggregate_id=$2 GROUP BY event_type",
      [item.tenant, device],
    ),
    binding: await counts(
      process.env.TELEMETRY_DIRECT_URL,
      item.tenant,
      "SELECT 'await' k,count(*)::int n FROM saga_binding_requests WHERE tenant_id=$1 AND saga_id=$2",
      args,
    ),
  };
  assert.deepEqual(summary, {
    commands: {
      "asset.reserve": 1,
      "asset.configure": 1,
      "inventory.activate": 1,
      "binding.await": 1,
    },
    results: { all: 4 },
    hardware: { "asset.reserve": 1, "asset.configure": 1 },
    inventory: { "inventory.activate": 1 },
    registeredEvents: { "device.registered": 1 },
    binding: { await: 1 },
  });
  return summary;
}
async function auditActions(item, sagaID) {
  const response = await request(item.tenant, `/v1/provisioning/${sagaID}`);
  return response.body.history.map((h) => h.action);
}
async function hardwareAsset(item) {
  const rows = await scoped(
    process.env.HARDWARE_DIRECT_URL,
    item.tenant,
    (db) =>
      db.query(
        "SELECT state,owner_saga_id FROM hardware_assets WHERE tenant_id=$1 AND asset_id=$2",
        [item.tenant, item.asset],
      ),
  );
  return rows.rows[0];
}
const out = {};
async function gateRace() {
  const item = gate.race;
  // Two requests with different idempotency keys race for one asset claim.
  const responses = await Promise.all(
    [1, 2].map(() =>
      request(item.tenant, "/v1/provisioning", "POST", {
        device_id: item.device,
        asset_id: item.asset,
      }),
    ),
  );
  const codes = responses.map((r) => r.status).sort();
  assert.deepEqual(codes, [202, 409], JSON.stringify(responses));
  const winner = responses.find((r) => r.status === 202).body;
  await waitState(item, winner.SagaID, "active", "race winner active");
  out.race = { codes, dup: await assertNoDuplicates(item, winner.SagaID) };
}
async function gateKill() {
  const item = gate.kill;
  const sagaID = await provision(item);
  const kills = [];
  const order = ["saga", "hardware", "inventory", "telemetry"];
  // SIGKILL every service at each newly committed saga version: just after the
  // transition/outbox commit and around its command publication.
  const end = Date.now() + 240_000;
  let seen = 0;
  while (Date.now() < end) {
    const state = await status(item, sagaID);
    if (state.State === "active") break;
    if (state.Version !== seen) {
      seen = state.Version;
      for (const name of order) {
        kills.push(`${name}@${state.State}/v${state.Version}`);
        await kill9(procs[name]);
        await restart(name);
      }
    }
    await delay(150);
  }
  await waitState(item, sagaID, "active", "active after SIGKILL rotation");
  out.kill = { kills, dup: await assertNoDuplicates(item, sagaID) };
}
async function gateOutage() {
  const item = gate.outage;
  await stop(procs.hardware);
  const sagaID = await provision(item);
  await delay(6000);
  const pending = await sagaDb(
    item.tenant,
    `SELECT s.state, o.published_at IS NOT NULL AS published,
      (SELECT count(*)::int FROM saga_result_inbox i WHERE i.tenant_id=s.tenant_id AND i.saga_id=s.saga_id) AS results
     FROM provisioning_sagas s JOIN saga_command_outbox o ON o.tenant_id=s.tenant_id AND o.saga_id=s.saga_id
     WHERE s.tenant_id=$1 AND s.saga_id=$2`,
    [item.tenant, sagaID],
  );
  assert.deepEqual(pending.rows, [
    { state: "reserving", published: true, results: 0 },
  ]);
  startParticipant("hardware");
  await waitState(item, sagaID, "active", "active after participant recovery");
  out.outage = {
    pendingWhileDown: pending.rows[0],
    dup: await assertNoDuplicates(item, sagaID),
  };
}
async function gateBroker() {
  const item = gate.broker;
  const sagaID = await provision(item);
  const kafka = composeContainerName("kafka");
  const paused = spawnSync("docker", ["pause", kafka], {
    encoding: "utf8",
  });
  assert.equal(paused.status, 0, paused.stderr);
  try {
    await delay(8000);
  } finally {
    spawnSync("docker", ["unpause", kafka]);
  }
  const restarted = [];
  for (let i = 0; i < 40; i++) {
    await ensureRunning(restarted);
    const state = await status(item, sagaID);
    if (state.State === "active") break;
    await delay(3000);
  }
  await waitState(item, sagaID, "active", "active after broker outage", 30_000);
  out.broker = {
    pausedSeconds: 8,
    restartedAfterOutage: restarted,
    dup: await assertNoDuplicates(item, sagaID),
  };
}
async function gateTimeout() {
  const item = gate.timeout;
  const sagaID = await provision(item);
  await waitState(item, sagaID, "configuring", "configure pending without ack");
  await delay(1500);
  await forceDeadline(item, sagaID);
  await waitState(item, sagaID, "compensated", "timeout compensation");
  const actions = await auditActions(item, sagaID);
  assert.ok(actions.includes("deadline.compensate"), actions.join(","));
  assert.deepEqual(await hardwareAsset(item), {
    state: "available",
    owner_saga_id: null,
  });
  const pending = await counts(
    process.env.HARDWARE_DIRECT_URL,
    item.tenant,
    "SELECT outcome k,count(*)::int n FROM hardware_command_receipts WHERE tenant_id=$1 AND saga_id=$2 AND step='asset.configure' GROUP BY outcome",
    [item.tenant, sagaID],
  );
  out.timeout = { actions, configureReceipts: pending };
}
async function gateRedrive() {
  const item = gate.redrive;
  await stop(procs.hardware);
  const sagaID = await provision(item);
  await waitFor(
    async () =>
      (
        await sagaDb(
          item.tenant,
          "SELECT 1 FROM saga_command_outbox WHERE tenant_id=$1 AND saga_id=$2 AND published_at IS NOT NULL",
          [item.tenant, sagaID],
        )
      ).rowCount > 0,
    "reserve published while hardware is down",
  );
  await forceDeadline(item, sagaID);
  await waitState(item, sagaID, "compensating", "deadline compensation queued");
  await delay(1500);
  await forceDeadline(item, sagaID);
  await waitState(
    item,
    sagaID,
    "repair_required",
    "compensation timeout quarantined",
  );
  const redrive = await fetch(
    `http://127.0.0.1:18092/v1/provisioning/${sagaID}/redrive`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt(item.tenant)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reason: "stage07 gate: hardware worker restored",
      }),
      signal: AbortSignal.timeout(5000),
    },
  );
  assert.equal(redrive.status, 202, await redrive.text());
  const crossTenant = await fetch(
    `http://127.0.0.1:18092/v1/provisioning/${sagaID}/redrive`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt(tenants[0])}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "cross tenant" }),
      signal: AbortSignal.timeout(5000),
    },
  );
  assert.equal(
    crossTenant.status,
    404,
    "tenant A must not redrive tenant B saga",
  );
  startParticipant("hardware");
  await waitState(
    item,
    sagaID,
    "compensated",
    "compensated after operator redrive",
  );
  const actions = await auditActions(item, sagaID);
  for (const action of [
    "deadline.compensate",
    "deadline.expired",
    "operator.replay",
  ])
    assert.ok(
      actions.includes(action),
      `${action} missing: ${actions.join(",")}`,
    );
  assert.deepEqual(await hardwareAsset(item), {
    state: "available",
    owner_saga_id: null,
  });
  const releases = await counts(
    process.env.HARDWARE_DIRECT_URL,
    item.tenant,
    "SELECT step k,count(*)::int n FROM hardware_command_receipts WHERE tenant_id=$1 AND saga_id=$2 GROUP BY step",
    [item.tenant, sagaID],
  );
  assert.equal(releases["asset.release"], 1);
  out.redrive = { actions, hardwareReceipts: releases };
}
async function leaseRow(tenant) {
  const shard = createHash("sha256").update(tenant).digest()[0] % 64;
  const db = new pg.Client({ connectionString: process.env.SAGA_DIRECT_URL });
  await db.connect();
  try {
    const r = await db.query(
      "SELECT shard,holder,fencing_token::int AS token FROM saga_shard_leases WHERE shard=$1",
      [shard],
    );
    return r.rows[0];
  } finally {
    await db.end();
  }
}
async function gateLease() {
  const item = gate.lease;
  const a = procs.saga;
  const before = await leaseRow(item.tenant);
  const b = startSaga("saga-worker-B", false);
  a.kill("SIGSTOP");
  let after;
  let sagaID;
  try {
    after = await waitFor(
      async () => {
        const row = await leaseRow(item.tenant);
        return row.holder?.includes("saga-worker-B") && row;
      },
      "worker B takes over the expired lease",
      30_000,
    );
    assert.ok(
      after.token > before.token,
      "takeover must raise the fencing token",
    );
    sagaID = await provision(item);
  } finally {
    a.kill("SIGCONT");
  }
  await waitState(item, sagaID, "active", "active under the new lease holder");
  await delay(1500);
  out.lease = {
    before,
    after,
    staleRefusedInLog: /lease lost/.test(
      [...logs]
        .filter(([k]) => k.startsWith("saga") && !k.includes("-B"))
        .map(([, v]) => v)
        .join("\n"),
    ),
    dup: await assertNoDuplicates(item, sagaID),
  };
  await stop(b);
}
async function runGate() {
  for (const [name, fn] of [
    ["race", gateRace],
    ["kill", gateKill],
    ["outage", gateOutage],
    ["timeout", gateTimeout],
    ["redrive", gateRedrive],
    ["lease", gateLease],
    ["broker", gateBroker],
  ]) {
    // The broker gate pauses the shared Kafka container; skip it on a shared stack.
    if (name === "broker" && process.env.STAGE07_SKIP_BROKER_PAUSE === "1") {
      console.log("GATE broker: SKIPPED (STAGE07_SKIP_BROKER_PAUSE=1)");
      continue;
    }
    const started = Date.now();
    await fn();
    console.log(
      `GATE ${name}: PASS (${Date.now() - started} ms) ${JSON.stringify(out[name])}`,
    );
  }
}

try {
  await main();
} finally {
  for (const child of children.reverse()) await stop(child);
  if (idpStarted) await new Promise((resolve) => idp.close(resolve));
  placementAuthority?.close();
  await admin?.disconnect();
  rmSync(tmp, { recursive: true, force: true });
}
