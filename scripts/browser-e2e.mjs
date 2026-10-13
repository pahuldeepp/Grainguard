// Stage 08 live browser gate: real Chromium -> built dashboard -> gateway -> BFF -> saga API
// (workers, hardware MQTT signed ack, device-service and telemetry participants)
// and -> Read API (Postgres read DB, Cassandra, Elasticsearch, Redis Cluster).
// Mandatory Stage 08 CI gate: `make browser-e2e`. Never prints tokens.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import * as S from "./browser-e2e-stack.mjs";
import {
  bootstrapTenantOwnership,
  controlIncarnations,
  localShardSelection,
  startPlacementAuthority,
  writeServiceRegistry,
} from "./placement-fixture.mjs";
import { isInteractiveAuthorizeRequest } from "./oidc-authorize-request.mjs";
import { operations } from "../services/bff/dist/query-policy.js";

process.loadEnvFile(".env");
const { PORTS, waitFor, scoped, fixtureScoped } = S;
const OUT_BASE = "evidence/stage08-e2e";
const RUN_ID = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const OUT = path.join(OUT_BASE, "runs", RUN_ID);
const LOCK = path.join(OUT_BASE, ".browser-e2e.lock");
const ISSUER = "http://127.0.0.1:5556/dex";
// The dashboard is served on [::1]:5173 as http://localhost:5173 (a Dex-registered
// redirect URI) so it never collides with a developer's IPv4 vite on 127.0.0.1:5173.
const DASHBOARD = `http://localhost:${PORTS.dashboard}`;
// Node-side requests use the bound socket directly. Chromium maps localhost to both
// loopbacks itself, but Node asks the OS, and a stock Ubuntu /etc/hosts (the CI
// runner VM) lists localhost only as 127.0.0.1, where this harness does not listen.
const DASHBOARD_SOCKET = `http://[::1]:${PORTS.dashboard}`;
const password = process.env.OIDC_DEV_PASSWORD;
const TENANT = {
  a: "0a0a0a0a-0000-4000-8000-00000000000a",
  b: "0b0b0b0b-0000-4000-8000-00000000000b",
};
const id = randomUUID().slice(0, 8);
// Tenant placement (set in stackUp): every DB-writing service resolves ownership
// through a private shard registry and a placement authority.
let placementEnv = () => ({});
let sagaAdmissionContext;
const tmp = mkdtempSync(path.join(tmpdir(), "greenguard-browser-e2e-"));
const alias = `greenguard-browser-e2e-${id}`;
const failures = [];
const results = [];
const procs = {};
const servers = [];
const issuer = S.makeIssuer(id);

function acquireRunLock() {
  mkdirSync(OUT_BASE, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(readFileSync(LOCK, "utf8"));
      if (Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
          throw new Error(`browser E2E already running as PID ${owner}`, {
            cause: error,
          });
        } catch (probe) {
          if (probe.code !== "ESRCH") throw probe;
        }
      }
      unlinkSync(LOCK);
    }
  }
  throw new Error("unable to acquire browser E2E run lock");
}

function check(name, ok, detail) {
  const line = `${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`;
  console.log(line);
  results.push(line);
  if (!ok) failures.push(name);
}

function item(tenant, name, acked) {
  return {
    name,
    tenant,
    acked,
    site: randomUUID(),
    device: randomUUID(),
    asset: randomUUID(),
    serial: `bre2e-${id}-${name}`,
    secret: randomBytes(32),
  };
}
const items = {
  main: item(TENANT.a, "main", true),
  reload: item(TENANT.a, "reload", true),
  repair: item(TENANT.a, "repair", false),
  bob: item(TENANT.b, "bob", true),
};
const alertFixture = {
  id: randomUUID(),
  rule: randomUUID(),
  bin: randomUUID(),
};

const authEnv = {
  AUTH_ISSUER: ISSUER,
  AUTH_AUDIENCE: "greenguard-dashboard",
  AUTH_JWKS_URL: `${ISSUER}/keys`,
  AUTH_MEMBERSHIP_FILE: path.resolve("infra/oidc/memberships.json"),
};

async function seed() {
  for (const it of Object.values(items)) {
    await fixtureScoped(
      process.env.INVENTORY_PROJECTOR_DIRECT_URL,
      it.tenant,
      (db) =>
        db.query(
          "INSERT INTO tenants(tenant_id,name) VALUES($1,'Browser E2E') ON CONFLICT DO NOTHING",
          [it.tenant],
        ),
    );
    await fixtureScoped(
      process.env.INVENTORY_DIRECT_URL,
      it.tenant,
      async (db) => {
        await db.query(
          "INSERT INTO sites(tenant_id,site_id,name) VALUES($1,$2,$3)",
          [it.tenant, it.site, `Browser E2E ${it.name}`],
        );
        await db.query(
          `INSERT INTO devices(tenant_id,device_id,site_id,serial_number,status,asset_id)
         VALUES($1,$2,$3,$4,'provisioning',$5)`,
          [it.tenant, it.device, it.site, it.serial, it.asset],
        );
      },
    );
    await fixtureScoped(process.env.HARDWARE_DIRECT_URL, it.tenant, (db) =>
      db.query(
        `INSERT INTO hardware_assets(tenant_id,asset_id,serial_number,mqtt_ack_secret)
         VALUES($1,$2,$3,$4)`,
        [it.tenant, it.asset, it.serial, it.secret],
      ),
    );
  }
  await fixtureScoped(process.env.ALERTS_DIRECT_URL, TENANT.a, async (db) => {
    await db.query(
      `INSERT INTO alert_rules(tenant_id,rule_id,rule_key,resource_kind,open_score,clear_score,escalation_timeout_seconds)
       VALUES($1,$2,$3,'bin',70,40,300)`,
      [TENANT.a, alertFixture.rule, `browser-e2e-${id}`],
    );
    await db.query(
      `INSERT INTO alert_episodes(tenant_id,episode_id,rule_id,monitored_resource_id,open_window_start,state,severity,score,version,opened_at,updated_at)
       VALUES($1,$2,$3,$4,now(),'open','critical',87,1,now(),now())`,
      [TENANT.a, alertFixture.id, alertFixture.rule, alertFixture.bin],
    );
  });
  const fixtures = Object.values(items)
    .filter((it) => it.acked)
    .map((it) => ({
      tenant_id: it.tenant,
      asset_id: it.asset,
      secret_hex: it.secret.toString("hex"),
    }));
  const file = path.join(tmp, "mqtt-fixtures.json");
  writeFileSync(file, JSON.stringify(fixtures), { mode: 0o600 });
  return file;
}

async function offsets() {
  const tenants = [TENANT.a, TENANT.b];
  const cell = S.cellFor(tenants);
  const raw = [
    "greenguard.raw.inventory.outbox",
    "greenguard.raw.telemetry.outbox",
    "greenguard.raw.risk.outbox",
    "greenguard.raw.alerts.outbox",
  ];
  const commands = ["greenguard.saga.commands.v1"];
  await S.seedOffsets([
    [`browser-e2e-cdc-${id}`, raw, true],
    [`browser-e2e-saga-${id}`, ["greenguard.saga.results.v1"], true],
    [`greenguard-inventory-saga-v1-${cell}`, commands, true],
    [`telemetry-saga-binding-v1-${cell}`, commands, true],
    ["greenguard.hardware.v1", commands, true],
    [
      `browser-e2e-search-${id}`,
      ["greenguard.inventory.device.v1", "greenguard.inventory.facility.v1"],
      true,
    ],
    [
      "projection-builder",
      ["greenguard.telemetry.recorded.v1", "greenguard.inventory.device.v1"],
      false,
    ],
    ["cassandra-writer", ["greenguard.telemetry.recorded.v1"], false],
  ]);
}

function buildAll() {
  const b = (module, target, name) => S.buildGo(tmp, module, target, name);
  return {
    saga: b("services/saga-orchestrator", "./cmd/worker", "saga-worker"),
    sagaApi: b("services/saga-orchestrator", "./cmd/api", "saga-api"),
    hardware: b("services/hardware-service", "./cmd/worker", "hardware-worker"),
    fixture: b(
      "services/hardware-service",
      "./cmd/mqtt-fixture",
      "mqtt-fixture",
    ),
    telemetry: b("services/telemetry-ingest", ".", "telemetry-ingest"),
    cdc: b("services/cdc-transformer", ".", "cdc-transformer"),
    projection: b("services/projection-builder", ".", "projection-builder"),
    cassandra: b("services/cassandra-writer", ".", "cassandra-writer"),
  };
}

const schemaDir = path.resolve("contracts/events");
const redisNodes = [1, 2, 3, 4, 5, 6];
const redisServices = redisNodes.map((n) => `redis-node-${n}`);

function redisCompose(...args) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      ".env",
      "-f",
      "infra/redis/compose.yaml",
      ...args,
    ],
    { encoding: "utf8", timeout: 90_000 },
  );
  if (result.status !== 0)
    throw new Error(
      `Redis compose ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || "unknown error").slice(-1000)}`,
    );
}
const readEnv = (port, overrides = {}) => ({
  ...authEnv,
  READ_API_PORT: String(port),
  CASSANDRA_HOSTS: "127.0.0.1:59042",
  ELASTICSEARCH_URL: "http://127.0.0.1:19200",
  SEARCH_ALIAS: alias,
  READ_REDIS_URL: "",
  READ_REDIS_CLUSTER_NODES: redisNodes
    .map((n) => `redis://127.0.0.1:710${n}`)
    .join(","),
  READ_REDIS_NODE_ADDRESS_MAP: redisNodes
    .map((n) => `redis-node-${n}:6379=127.0.0.1:710${n}`)
    .join(","),
  ...overrides,
});
const bffEnv = (port, readUrl) => ({
  ...authEnv,
  BFF_PORT: String(port),
  SAGA_API_URL: `http://127.0.0.1:${PORTS.sagaApi}`,
  READ_API_URL: readUrl,
  ALERT_API_URL: `http://127.0.0.1:${PORTS.alerts}`,
  BFF_RATE_REDIS_URL: "",
  BFF_RATE_REDIS_CLUSTER_NODES: "",
  BFF_ALLOW_NO_RATE_LIMIT: "true",
});
const gatewayEnv = (port, bffPort, readPort, metricsPort) => ({
  ...authEnv,
  GATEWAY_PORT: String(port),
  GATEWAY_METRICS_PORT: String(metricsPort),
  GATEWAY_BFF_URL: `http://127.0.0.1:${bffPort}`,
  GATEWAY_READ_URL: `http://127.0.0.1:${readPort}`,
  GATEWAY_SAGA_URL: `http://127.0.0.1:${PORTS.sagaApi}`,
});

function startHardware(bins) {
  procs.hardware = S.start(
    "hardware",
    bins.hardware,
    [],
    "services/hardware-service",
    {
      KAFKA_BROKERS: S.broker,
      MQTT_BROKER_URL: "tcp://127.0.0.1:51883",
      MQTT_CLIENT_ID: `browser-e2e-${id}-hardware`,
      ...placementEnv("hardware-service", "hardware", "HARDWARE_DIRECT_URL"),
    },
  );
}

function startBackends(bins, fixtureFile) {
  const start = S.start;
  start("mqtt-fixture", bins.fixture, [], "services/hardware-service", {
    MQTT_BROKER_URL: "tcp://127.0.0.1:51883",
    MQTT_FIXTURES_FILE: fixtureFile,
  });
  startHardware(bins);
  start(
    "inventory",
    process.execPath,
    ["dist/saga/main.js"],
    "services/device-service",
    {
      KAFKA_BROKERS: S.broker,
      ...placementEnv("device-service", "inventory", "INVENTORY_DIRECT_URL"),
    },
  );
  start("telemetry", bins.telemetry, [], "services/telemetry-ingest", {
    KAFKA_BROKERS: S.broker,
    SAGA_BINDING_ENABLED: "1",
    EVENT_SCHEMA_DIR: schemaDir,
    HTTP_ADDR: `127.0.0.1:${PORTS.telemetry}`,
    AUTH_ISSUER: issuer.iss,
    AUTH_AUDIENCE: "greenguard-ingest",
    AUTH_JWKS_URL: `http://127.0.0.1:${PORTS.idp}/keys`,
    INGEST_BINDING_FEED_MAX_STALE: "45s",
    ...placementEnv("telemetry-ingest", "telemetry", "TELEMETRY_DIRECT_URL"),
  });
  start("cdc", bins.cdc, [], "services/cdc-transformer", {
    KAFKA_BROKERS: S.broker,
    KAFKA_GROUP_ID: `browser-e2e-cdc-${id}`,
    EVENT_SCHEMA_DIR: schemaDir,
    HTTP_ADDR: `127.0.0.1:${PORTS.cdc}`,
  });
  start("projection", bins.projection, [], "services/projection-builder", {
    KAFKA_BROKERS: S.broker,
    EVENT_SCHEMA_DIR: schemaDir,
    ...placementEnv("projection-builder", "read", "PROJECTION_DIRECT_URL"),
  });
  start("cassandra-writer", bins.cassandra, [], "services/cassandra-writer", {
    KAFKA_BROKERS: S.broker,
    CASSANDRA_HOSTS: "127.0.0.1:59042",
    CASSANDRA_KEYSPACE: "greenguard_history",
    CASSANDRA_DATACENTER: "datacenter1",
    EVENT_SCHEMA_DIR: schemaDir,
    HTTP_ADDR: `127.0.0.1:${PORTS.cassandraWriter}`,
  });
  start(
    "search-indexer",
    path.resolve(".local/search-venv/bin/python"),
    [
      "search_indexer.py",
      "consume",
      "--version",
      "1",
      "--group",
      `browser-e2e-search-${id}`,
      "--quarantine",
      path.join(tmp, "search-quarantine.jsonl"),
    ],
    "services/search-indexer",
    { SEARCH_ALIAS: alias, HEALTH_PORT: String(PORTS.searchHealth) },
  );
  start("saga-api", bins.sagaApi, [], "services/saga-orchestrator", {
    ...authEnv,
    SAGA_API_ADDR: `127.0.0.1:${PORTS.sagaApi}`,
    ...placementEnv("saga-orchestrator", "sagas", "SAGA_DIRECT_URL"),
  });
  start("saga-worker", bins.saga, [], "services/saga-orchestrator", {
    KAFKA_BROKERS: S.broker,
    SAGA_RESULT_GROUP: `browser-e2e-saga-${id}`,
    SAGA_LEASE_TTL_SECONDS: "3",
    SAGA_WORKER_ID: `browser-e2e-${id}`,
    ...placementEnv("saga-orchestrator", "sagas", "SAGA_DIRECT_URL"),
  });
  start(
    "read-api",
    process.execPath,
    ["dist/main.js"],
    "services/read-api",
    readEnv(PORTS.read),
  );
  start(
    "alerts",
    process.execPath,
    ["dist/main.js"],
    "services/workflow-alerts",
    {
      ...authEnv,
      PORT: String(PORTS.alerts),
      KAFKA_BROKERS: "",
      // Local-only signing keys for this run (the service requires >= 32 bytes).
      ALERTS_ACTOR_HMAC_KEY: randomBytes(32).toString("hex"),
      ALERTS_HISTORY_CURSOR_KEY: randomBytes(32).toString("hex"),
      ...placementEnv("workflow-alerts", "alerts", "ALERTS_DIRECT_URL"),
    },
  );
  start(
    "bff",
    process.execPath,
    ["dist/main.js"],
    "services/bff",
    bffEnv(PORTS.bff, `http://127.0.0.1:${PORTS.read}`),
  );
  start(
    "bff-degraded",
    process.execPath,
    ["dist/main.js"],
    "services/bff",
    bffEnv(PORTS.bffDegraded, `http://127.0.0.1:${PORTS.deadRead}`),
  );
  start(
    "gateway",
    process.execPath,
    ["dist/main.js"],
    "services/gateway",
    gatewayEnv(PORTS.gateway, PORTS.bff, PORTS.read, PORTS.gatewayMetrics),
  );
  start(
    "gateway-degraded",
    process.execPath,
    ["dist/main.js"],
    "services/gateway",
    gatewayEnv(
      PORTS.gatewayDegraded,
      PORTS.bffDegraded,
      PORTS.deadRead,
      PORTS.gatewayDegradedMetrics,
    ),
  );
}

async function healthy(url, ok = (s) => s < 300) {
  const r = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch(
    () => null,
  );
  return r && ok(r.status);
}

async function aliasSearchIndex() {
  await waitFor(
    () => healthy(`http://127.0.0.1:19200/${alias}-v1`),
    "search index created",
    60_000,
  );
  const r = await fetch("http://127.0.0.1:19200/_aliases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actions: [{ add: { index: `${alias}-v1`, alias } }],
    }),
  });
  if (!r.ok) throw new Error(`alias: ${r.status} ${await r.text()}`);
}

// ---------- Browser helpers ----------
async function signIn(page, user) {
  const [authorize] = await Promise.all([
    page.waitForRequest((r) => isInteractiveAuthorizeRequest(r.url(), ISSUER)),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  const url = new URL(authorize.url());
  await page.waitForSelector('input[name="login"]');
  await page.fill('input[name="login"]', `${user}@greenguard.test`);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page
    .getByRole("button", { name: "Sign out" })
    .waitFor({ timeout: 20_000 });
  return url.searchParams;
}

async function newUser(browser, user) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__ggSockets = [];
    window.__ggSocketEvents = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__ggSockets.push(this);
        this.addEventListener("message", (event) => {
          try {
            window.__ggSocketEvents.push(JSON.parse(event.data).type);
          } catch {
            // The protocol error is checked by the missing connection ack.
          }
        });
      }
    };
  });
  const graphql = [];
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[browser:${user}] ${m.text()}`);
  });
  page.on("request", (r) => {
    if (r.url().endsWith("/graphql")) graphql.push(r);
  });
  let token = "";
  page.on("request", (r) => {
    const h = r.headers().authorization;
    if (r.url().endsWith("/graphql") && h) token = h.replace(/^Bearer /, "");
  });
  await page.goto(DASHBOARD);
  const params = await signIn(page, user);
  return { user, context, page, graphql, params, token: () => token };
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

async function waitVisible(locator, timeout = 15_000) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

async function badge(page) {
  return (
    (
      await page
        .locator(".provisioning-status strong + *")
        .first()
        .textContent({ timeout: 1000 })
        .catch(() => "")
    )?.trim() ?? ""
  );
}

async function watchStates(page, until, timeoutMs) {
  const seen = [];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = await badge(page);
    if (state && seen.at(-1) !== state) seen.push(state);
    if (until.includes(state)) return seen;
    await delay(250);
  }
  return seen;
}

async function historyText(page) {
  return (
    await page.locator(".provisioning-status ol li").allTextContents()
  ).map((t) => t.split(" · ")[0]);
}

async function startInUi(page, it) {
  await page.getByRole("link", { name: "Provisioning", exact: true }).click();
  await page.getByLabel("Device ID").fill(it.device);
  await page.getByLabel("Physical sensor asset ID").fill(it.asset);
  const sent = page.waitForRequest(
    (r) =>
      r.url().endsWith("/graphql") &&
      (r.postData() ?? "").includes("idempotencyKey"),
  );
  const answered = page.waitForResponse(
    (r) =>
      r.url().endsWith("/graphql") &&
      (r.request().postData() ?? "").includes("idempotencyKey"),
  );
  await page.getByRole("button", { name: "Start provisioning" }).click();
  const body = JSON.parse((await sent).postData());
  const response = await (await answered).json();
  return {
    key: body.variables.idempotencyKey,
    saga: response.data?.startProvisioning,
    errors: response.errors,
  };
}

async function sagaRows(it) {
  return scoped(
    process.env.SAGA_DIRECT_URL,
    it.tenant,
    async (db) =>
      (
        await db.query(
          "SELECT saga_id,state FROM provisioning_sagas WHERE tenant_id=$1 AND device_id=$2",
          [it.tenant, it.device],
        )
      ).rows,
  );
}

async function sagaDb(it, sql, args) {
  return scoped(
    process.env.SAGA_DIRECT_URL,
    it.tenant,
    (db) => db.query(sql, args),
    false,
    sagaAdmissionContext,
  );
}

const hash = (q) => createHash("sha256").update(q).digest("hex");
async function gql(token, query, variables, port = PORTS.gateway) {
  const r = await fetch(`http://127.0.0.1:${port}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash(query) } },
    }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const code = (res) =>
  res.body?.errors?.[0]?.extensions?.code ?? res.body?.code ?? null;

// ---------- Scenarios ----------
async function preflight(tokenAlice) {
  // A verified Dex identity with active membership reaches the saga API
  // directly; an unknown saga is 404, not an authentication failure.
  const r = await fetch(
    `http://127.0.0.1:${PORTS.sagaApi}/v1/provisioning/${randomUUID()}`,
    {
      headers: { authorization: `Bearer ${tokenAlice}` },
    },
  );
  check(
    "saga API accepts a real Dex bearer and resolves GreenGuard membership",
    r.status === 404,
    `HTTP ${r.status} for an unknown saga`,
  );
  const gateway = await gql(tokenAlice, operations.session, {});
  check(
    "gateway accepts the Dex bearer and forwards GraphQL to the BFF",
    gateway.status === 200 && Boolean(gateway.body?.data?.session?.tenantId),
    `HTTP ${gateway.status} tenant=${gateway.body?.data?.session?.tenantId ?? "none"}`,
  );
  const anonymous = await fetch(`http://127.0.0.1:${PORTS.gateway}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check(
    "gateway rejects an anonymous GraphQL request",
    anonymous.status === 401,
    `HTTP ${anonymous.status}`,
  );
}

async function scenarioProvision(alice) {
  const it = items.main;
  const params = alice.params;
  check(
    "S1 alice login used auth code + PKCE S256 with state and nonce",
    params.get("response_type") === "code" &&
      params.get("code_challenge_method") === "S256" &&
      Boolean(params.get("state") && params.get("nonce")),
    `response_type=${params.get("response_type")} method=${params.get("code_challenge_method")}`,
  );
  const started = await startInUi(alice.page, it);
  check(
    "S1 UI start sends an Idempotency-Key and gets a saga",
    Boolean(started.key && started.saga?.sagaId),
    `key=${started.key?.slice(0, 8)}… saga=${started.saga?.sagaId} state=${started.saga?.state} errors=${JSON.stringify(started.errors ?? null)}`,
  );
  it.saga = started.saga?.sagaId;
  it.key = started.key;
  const seen = await watchStates(
    alice.page,
    ["active", "compensated", "repair required"],
    150_000,
  );
  const history = await historyText(alice.page);
  check(
    "S1 UI polls durable status to active",
    seen.at(-1) === "active",
    `badges seen=[${seen.join(" -> ")}] history=[${history.join(", ")}]`,
  );
  await shot(alice.page, "s1-alice-active");
  return it;
}

async function scenarioReload(browser, alice) {
  const it = items.reload;
  const first = await startInUi(alice.page, it);
  it.saga = first.saga?.sagaId;
  const before = await badge(alice.page).catch(() => "");
  await alice.page.reload();
  const needSignIn = await waitVisible(
    alice.page.getByRole("button", { name: "Sign in" }),
    5000,
  );
  if (needSignIn) {
    await signIn(alice.page, "alice");
  } else {
    await alice.page
      .getByRole("button", { name: "Sign out" })
      .waitFor({ timeout: 15_000 });
  }
  const url = alice.page.url();
  const restored = await waitVisible(
    alice.page.locator(".provisioning-status"),
  );
  const after = await badge(alice.page);
  check(
    "S2 reload mid-provisioning retains sign-in and restores the tracked saga",
    !needSignIn && restored && url.includes(it.saga ?? "missing"),
    `before=${before || "(not yet rendered)"} signInRequired=${needSignIn} url=${url.replace(DASHBOARD, "")} restoredState=${after}`,
  );
  const again = await startInUi(alice.page, it);
  const rows = await sagaRows(it);
  check(
    "S2 repeated Start after reconnect reuses the saga (no second saga)",
    again.saga?.sagaId === it.saga &&
      rows.length === 1 &&
      again.key === first.key,
    `firstKey=${first.key?.slice(0, 8)} secondKey=${again.key?.slice(0, 8)} second=${again.saga?.sagaId ?? JSON.stringify(again.errors)} sagasForDevice=${rows.length}`,
  );
  const seen = await watchStates(
    alice.page,
    ["active", "compensated", "repair required"],
    150_000,
  );
  check(
    "S2 reconnected UI reaches active",
    seen.at(-1) === "active",
    `badges seen=[${seen.join(" -> ")}]`,
  );
  await shot(alice.page, "s2-alice-after-reload");
}

async function scenarioRepair(alice, victorToken, bins) {
  const it = items.repair;
  await S.stop(procs.hardware);
  const started = await startInUi(alice.page, it);
  it.saga = started.saga?.sagaId;
  const pendingSeen = await watchStates(
    alice.page,
    ["reserving", "pending"],
    15_000,
  );
  await waitFor(
    async () =>
      (
        await sagaDb(
          it,
          "SELECT 1 FROM saga_command_outbox WHERE tenant_id=$1 AND saga_id=$2 AND published_at IS NOT NULL",
          [it.tenant, it.saga],
        )
      ).rowCount > 0,
    "reserve published while hardware is down",
  );
  await shot(alice.page, "s3-pending-participant-down");
  const force = () =>
    sagaDb(
      it,
      "UPDATE provisioning_sagas SET deadline_at=now()-interval '1 second' WHERE tenant_id=$1 AND saga_id=$2",
      [it.tenant, it.saga],
    );
  await force();
  const compensating = await watchStates(alice.page, ["compensating"], 60_000);
  await delay(1500);
  await force();
  const repairSeen = await watchStates(alice.page, ["repair required"], 90_000);
  const redriveVisible = await alice.page
    .getByRole("button", { name: "Administrator redrive" })
    .isVisible();
  await shot(alice.page, "s3-repair-required");
  check(
    "S3 participant down renders pending -> compensating -> repair required with admin redrive",
    repairSeen.at(-1) === "repair required" && redriveVisible,
    `seen=[${[...pendingSeen, ...compensating, ...repairSeen].join(" -> ")}] redriveButton=${redriveVisible}`,
  );
  const viewer = await gql(victorToken, operations.redriveProvisioning, {
    id: it.saga,
    reason: "viewer attempt",
  });
  check(
    "S3 viewer cannot redrive (API)",
    code(viewer) === "insufficient_role" || code(viewer) === "FORBIDDEN",
    `code=${code(viewer)}`,
  );
  await alice.page
    .getByLabel("Redrive reason")
    .fill("browser e2e: hardware worker restored");
  await alice.page
    .getByRole("button", { name: "Administrator redrive" })
    .click();
  startHardware(bins);
  const final = await watchStates(
    alice.page,
    ["compensated", "active"],
    120_000,
  );
  const history = await historyText(alice.page);
  check(
    "S3 admin redrive through UI completes compensation",
    final.at(-1) === "compensated" && history.includes("operator.replay"),
    `seen=[${final.join(" -> ")}] history=[${history.join(", ")}]`,
  );
  await shot(alice.page, "s3-after-redrive");
}

function deviceToken(it) {
  return issuer.token({
    aud: "greenguard-ingest",
    sub: it.device,
    tenant_id: it.tenant,
    roles: ["device"],
  });
}

async function ingest(it, observedAt, temperature, humidity) {
  const sourceMessageId = `bre2e-${id}-${observedAt.getTime()}`;
  const r = await fetch(
    `http://127.0.0.1:${PORTS.telemetry}/v1/devices/${it.device}/readings`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken(it)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        source_message_id: sourceMessageId,
        observed_at: observedAt.toISOString(),
        temperature_c: temperature,
        relative_humidity_percent: humidity,
      }),
    },
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function readApi(token, route) {
  const r = await fetch(`http://127.0.0.1:${PORTS.read}/api/v1/read${route}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function scenarioReads(alice) {
  const it = items.main;
  const token = alice.token();
  await waitFor(
    async () => (await readApi(token, `/devices/${it.device}`)).body.data,
    "device_views projection of activated device",
    120_000,
  );
  const hot = new Date(Date.now() - 60_000);
  const cold = new Date(Date.now() - 48 * 3600_000);
  const accepted = await waitFor(
    async () => {
      const r = await ingest(it, hot, 18.25, 61.5);
      return r.status === 202
        ? r
        : (console.log(`ingest retry: ${r.status} ${JSON.stringify(r.body)}`),
          null);
    },
    "hot reading accepted (binding + fresh feed)",
    120_000,
  );
  const coldRes = await ingest(it, cold, 12.5, 55);
  check(
    "S4 device-token ingest accepted hot and 48h-old readings",
    accepted.status === 202 && coldRes.status === 202,
    `hot=${accepted.status} reading=${accepted.body.reading_id ?? "?"} cold=${coldRes.status} ${JSON.stringify(coldRes.body).slice(0, 120)}`,
  );
  await waitFor(
    async () =>
      (await readApi(token, `/devices/${it.device}/latest`)).body.data,
    "latest reading projected",
    90_000,
  );
  const from = new Date(Date.now() - 72 * 3600_000).toISOString();
  await waitFor(
    async () => {
      const r = await readApi(
        token,
        `/devices/${it.device}/readings?from=${from}&to=${new Date().toISOString()}&limit=10`,
      );
      return r.body.source === "cassandra" && r.body.data?.length >= 2;
    },
    "Cassandra history holds both readings",
    90_000,
  );
  await waitFor(
    async () =>
      (await readApi(token, `/search?q=${encodeURIComponent(it.serial)}`)).body
        .data?.length,
    "Elasticsearch indexed the device",
    90_000,
  );
  const page = alice.page;
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.fill("#device-search", it.serial);
  await page.getByRole("button", { name: "Search" }).click();
  const hit = page.getByRole("link", { name: new RegExp(it.serial) });
  const found = await waitVisible(hit);
  await shot(page, "s4-search-elasticsearch");
  check(
    "S4 UI search (Elasticsearch via BFF/Read API) finds the device",
    found,
    `serial=${it.serial}`,
  );
  await hit.click();
  await page.locator(".read-table").waitFor({ timeout: 15_000 });
  const subscribed = await waitFor(
    async () =>
      page.evaluate(() => window.__ggSocketEvents.includes("connection_ack")),
    "browser GraphQL subscription handshake",
    15_000,
  ).catch(() => false);
  const firstSockets = await page.evaluate(() => window.__ggSockets.length);
  await page.evaluate(() => window.__ggSockets.at(-1)?.close());
  const reconnected = await waitFor(
    async () =>
      page.evaluate(
        (count) =>
          window.__ggSockets.length > count &&
          window.__ggSocketEvents.filter((type) => type === "connection_ack")
            .length >= 2,
        firstSockets,
      ),
    "browser GraphQL subscription reconnect",
    15_000,
  ).catch(() => false);
  check(
    "S4 browser subscription uses ticket handshake and reconnects",
    subscribed && reconnected,
    `firstAck=${subscribed} reconnected=${reconnected}`,
  );
  const currentText = await page.locator(".read-view").textContent();
  await shot(page, "s4-current-postgres");
  check(
    "S4 UI current/latest reading from the read DB",
    currentText.includes("18.25") && currentText.includes("61.5"),
    `row contains 18.25 °C / 61.5 %: ${currentText.includes("18.25")}`,
  );
  await page.goto(
    `${DASHBOARD}/devices/${it.device}?readingId=${accepted.body.reading_id}`,
  );
  await signIn(page, "alice");
  const processed = await waitVisible(
    page.getByRole("status").filter({ hasText: "Reading processed at" }),
  );
  check(
    "S4 accepted reading ID reaches processed UI state after projection",
    processed,
    `reading=${accepted.body.reading_id} processed=${processed}`,
  );
  await shot(page, "s4-reading-processed");
  await page.getByRole("link", { name: "View reading history" }).click();
  await page.getByRole("button", { name: "Load history" }).click();
  await page.locator(".read-table").waitFor({ timeout: 15_000 });
  const recent = await page.locator(".read-table tbody tr").count();
  const recentText = await page.locator(".read-table").textContent();
  await shot(page, "s4-history-recent-postgres");
  check(
    "S4 UI recent history (default 12 h, Postgres hot window)",
    recent >= 1 && recentText.includes("18.25") && !recentText.includes("12.5"),
    `rows=${recent}`,
  );
  const local = (d) =>
    new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
  await page.fill("#history-from", local(new Date(Date.now() - 72 * 3600_000)));
  const coldResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/graphql") &&
      (r.request().postData() ?? "").includes('"from"'),
  );
  await page.getByRole("button", { name: "Load history" }).click();
  await coldResponse;
  await page
    .waitForFunction(
      () =>
        document.querySelector(".read-table")?.textContent?.includes("12.5"),
      null,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  const coldText = await page.locator(".read-table").textContent();
  const apiSource = await readApi(
    token,
    `/devices/${it.device}/readings?from=${from}&to=${new Date().toISOString()}&limit=10`,
  );
  await shot(page, "s4-history-older-cassandra");
  check(
    "S4 UI older range served from Cassandra",
    coldText.includes("12.5") && apiSource.body.source === "cassandra",
    `ui has 48h-old 12.5 °C=${coldText.includes("12.5")} readApi source=${apiSource.body.source} rows=${apiSource.body.data?.length}`,
  );
  return it;
}

async function scenarioRedisOutage(alice, bobToken) {
  const it = items.main;
  const page = alice.page;
  await page.goto(`${DASHBOARD}/devices/${it.device}`);
  await signIn(page, "alice");
  await page
    .locator(".read-view")
    .getByText("18.25", { exact: false })
    .waitFor();
  await waitFor(
    () =>
      page.evaluate(() => window.__ggSocketEvents.includes("connection_ack")),
    "subscription before Redis outage",
    15_000,
  );
  let stopped = false;
  let accepted;
  let reconnected;
  let projected = false;
  let scoped;
  try {
    stopped = true;
    redisCompose("stop", ...redisServices);
    const socketCount = await page.evaluate(() => window.__ggSockets.length);
    await page.evaluate(() => window.__ggSockets.at(-1)?.close());
    reconnected = await waitFor(
      () =>
        page.evaluate(
          (count) =>
            window.__ggSockets.length > count &&
            window.__ggSocketEvents.filter(
              (event) => event === "connection_ack",
            ).length >= 2,
          socketCount,
        ),
      "subscription reconnect during Redis outage",
      20_000,
    );
    accepted = await ingest(it, new Date(), 19.75, 62.25);
    if (accepted.status === 202) {
      projected = await waitFor(
        async () => {
          const result = await gql(alice.token(), operations.deviceCurrent, {
            id: it.device,
          });
          return (
            result.body.data?.latestReading?.readingId ===
            accepted.body.reading_id
          );
        },
        "fresh scoped reading during Redis outage",
        60_000,
      );
    }
    const otherTenant = await gql(bobToken, operations.deviceCurrent, {
      id: it.device,
    });
    scoped =
      otherTenant.body.data?.device === null &&
      otherTenant.body.data?.latestReading === null;
    await waitFor(
      async () =>
        (await page.locator(".read-view").textContent())?.includes("19.75"),
      "browser catches up after Redis outage and WebSocket reconnect",
      20_000,
    );
    await shot(page, "s8-redis-outage-reconnect");
  } finally {
    if (stopped) {
      redisCompose("up", "-d", "--wait", ...redisServices);
      redisCompose("up", "redis-cluster-init");
    }
  }
  const after = await gql(alice.token(), operations.deviceCurrent, {
    id: it.device,
  });
  const restored =
    after.body.data?.latestReading?.readingId === accepted?.body.reading_id;
  check(
    "S8 Redis outage and browser WebSocket reconnect preserve scoped fresh reads",
    accepted?.status === 202 && reconnected && projected && scoped && restored,
    `accepted=${accepted?.status} reconnect=${reconnected} projected=${projected} tenantIsolation=${scoped} restored=${restored}`,
  );
}

async function scenarioIsolation(browser, bobToken, victor) {
  const a = items.main;
  const bob = await newUser(browser, "bob");
  const page = bob.page;
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.fill("#device-search", a.serial);
  await page.getByRole("button", { name: "Search" }).click();
  const none = await waitVisible(
    page.getByText("No devices match this search."),
  );
  await shot(page, "s5-bob-search-no-tenant-a");
  check("S5 bob search cannot see tenant A device", none, `query=${a.serial}`);
  const token = bob.token();
  const dev = await gql(token, operations.deviceCurrent, { id: a.device });
  const hist = await gql(token, operations.deviceHistory, {
    id: a.device,
    from: new Date(Date.now() - 72 * 3600_000).toISOString(),
    to: new Date().toISOString(),
    limit: 10,
  });
  const saga = await gql(token, operations.provisioningStatus, { id: a.saga });
  const redrive = await gql(token, operations.redriveProvisioning, {
    id: items.repair.saga,
    reason: "cross tenant",
  });
  check(
    "S5 bob GraphQL cannot read A's device, readings, saga or redrive",
    dev.body.data?.device === null &&
      dev.body.data?.latestReading === null &&
      (hist.body.data?.readingHistory ?? []).length === 0 &&
      code(saga) === "not_found" &&
      code(redrive) !== null &&
      !redrive.body.data,
    `device=${JSON.stringify(dev.body.data?.device)} latest=${JSON.stringify(dev.body.data?.latestReading)} history=${hist.body.data?.readingHistory?.length} saga=${code(saga)} redrive=${code(redrive)}`,
  );
  await page.goto(`${DASHBOARD}/devices/${a.device}`);
  await signIn(page, "bob");
  const notFound = await waitVisible(
    page.getByText("Device not found in your workspace."),
  );
  await shot(page, "s5-bob-url-tenant-a-device");
  check(
    "S5 bob opening A's device URL sees not-found",
    notFound && page.url().includes(a.device),
    `url=${page.url().replace(DASHBOARD, "")}`,
  );
  await page.goto(`${DASHBOARD}/provisioning?saga=${a.saga}`);
  await signIn(page, "bob");
  const alert = await page
    .getByRole("alert")
    .textContent({ timeout: 15_000 })
    .catch(() => "");
  await shot(page, "s5-bob-url-tenant-a-saga");
  check(
    "S5 bob opening A's saga URL gets an error, no status",
    /not.?found/i.test(alert) &&
      !(await page.locator(".provisioning-status").isVisible()),
    `alert="${alert}"`,
  );
  const vp = victor.page;
  await vp.getByRole("link", { name: "Provisioning", exact: true }).click();
  await vp.getByRole("heading", { name: "Sensor provisioning" }).waitFor();
  await delay(1500);
  const startBtn = vp.getByRole("button", { name: "Start provisioning" });
  const visible = await startBtn.isVisible().catch(() => false);
  const enabled = visible ? await startBtn.isEnabled() : false;
  await shot(vp, "s5-victor-viewer-provisioning");
  const api = await gql(victor.token(), operations.startProvisioning, {
    deviceId: a.device,
    assetId: a.asset,
    idempotencyKey: randomUUID(),
  });
  check(
    "S5 viewer cannot start provisioning (UI hides/disables, API rejects)",
    !enabled && code(api) === "insufficient_role",
    `startVisible=${visible} startEnabled=${enabled} api=${code(api)}`,
  );
  const own = await gql(bobToken ?? token, operations.provisioningStatus, {
    id: items.bob.saga,
  });
  check(
    "S5 bob still reads own tenant saga",
    own.body.data?.provisioningStatus?.saga?.sagaId === items.bob.saga,
    `state=${own.body.data?.provisioningStatus?.saga?.state}`,
  );
  return bob;
}

async function scenarioA11y(pages) {
  const report = [];
  for (const [name, page] of pages) {
    const issues = await page.evaluate(() => {
      const out = [];
      const named = (el) =>
        (
          el.getAttribute("aria-label") ||
          el.textContent ||
          el.getAttribute("title") ||
          ""
        ).trim();
      for (const el of document.querySelectorAll("input, select, textarea")) {
        const labelled =
          el.labels?.length ||
          el.getAttribute("aria-label") ||
          el.getAttribute("aria-labelledby");
        if (!labelled && el.type !== "hidden")
          out.push(
            `critical: form control without label (${el.outerHTML.slice(0, 80)})`,
          );
      }
      for (const el of document.querySelectorAll("button, a[href]"))
        if (!named(el))
          out.push(
            `serious: control without accessible name (${el.outerHTML.slice(0, 80)})`,
          );
      for (const el of document.querySelectorAll("img"))
        if (!el.hasAttribute("alt")) out.push("serious: img without alt");
      const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
      for (const dup of new Set(ids.filter((v, i) => ids.indexOf(v) !== i)))
        out.push(`serious: duplicate id ${dup}`);
      if (!document.documentElement.lang)
        out.push("serious: html element has no lang");
      if (!document.title.trim()) out.push("serious: document has no title");
      if (!document.querySelector("main"))
        out.push("moderate: no main landmark");
      if (!document.querySelector("h1")) out.push("moderate: no h1");
      return out;
    });
    const snapshot = await page.locator("body").ariaSnapshot();
    writeFileSync(`${OUT}/a11y-${name}.aria.yml`, snapshot);
    report.push({ name, issues });
  }
  const blocking = report.flatMap((r) =>
    r.issues
      .filter((i) => /^(critical|serious)/.test(i))
      .map((i) => `${r.name}: ${i}`),
  );
  const other = report.flatMap((r) =>
    r.issues
      .filter((i) => !/^(critical|serious)/.test(i))
      .map((i) => `${r.name}: ${i}`),
  );
  check(
    "S6 accessibility smoke: zero serious/critical findings",
    blocking.length === 0,
    `pages=${report.map((r) => r.name).join(",")} blocking=${JSON.stringify(blocking)} other=${JSON.stringify(other)}`,
  );
}

async function scenarioDegraded(alice, dashboard) {
  const it = items.main;
  const page = alice.page;
  dashboard.state.target = PORTS.gatewayDegraded;
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.fill("#device-search", it.serial);
  await page.getByRole("button", { name: "Search" }).click();
  const searchAlert = await page
    .getByRole("alert")
    .textContent({ timeout: 15_000 })
    .catch(() => "");
  await shot(page, "s7-read-api-down-search");
  await page.getByRole("link", { name: "Provisioning", exact: true }).click();
  await page.getByLabel("Track provisioning ID").fill(it.saga);
  const partial = await waitVisible(page.locator(".provisioning-status"));
  const state = await badge(page);
  await shot(page, "s7-read-api-down-provisioning-still-works");
  check(
    "S7 Read API down: read views show an error, provisioning still works (partial)",
    /unavailable/i.test(searchAlert) && partial && state === "active",
    `searchAlert="${searchAlert}" provisioningState=${state}`,
  );
  dashboard.state.target = PORTS.gateway;
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.fill("#device-search", it.serial);
  await page.getByRole("button", { name: "Search" }).click();
  const recovered = await waitVisible(
    page.getByRole("link", { name: new RegExp(it.serial) }),
  );
  check(
    "S7 recovery: read views return after the Read API is reachable",
    recovered,
    `search hit=${recovered}`,
  );
}

async function scenarioAlerts(alice, victor, bobToken) {
  const page = alice.page;
  const alertResponses = [];
  const captureAlertResponse = async (response) => {
    if (!response.url().endsWith("/graphql")) return;
    const body = response.request().postData() ?? "";
    if (
      !body.includes(hash(operations.alertList)) &&
      !body.includes(hash(operations.acknowledgeAlert))
    )
      return;
    const payload = await response.json().catch(() => ({}));
    alertResponses.push({ status: response.status(), payload });
  };
  page.on("response", captureAlertResponse);
  try {
    await page.getByRole("link", { name: "Alerts", exact: true }).click();
    const listed = await waitVisible(
      page.getByText(`critical · Bin ${alertFixture.bin}`),
    );
    const bob = await gql(bobToken, operations.alertList, {
      limit: 25,
      state: "open",
    });
    const viewer = await gql(victor.token(), operations.acknowledgeAlert, {
      id: alertFixture.id,
      version: "1",
      idempotencyKey: randomUUID(),
    });
    check(
      "S8 alert list is tenant scoped and viewer cannot acknowledge",
      listed &&
        (bob.body?.data?.alerts?.items ?? []).length === 0 &&
        code(viewer) === "insufficient_role",
      `listed=${listed} bobItems=${bob.body?.data?.alerts?.items?.length ?? "error"} viewer=${code(viewer)}`,
    );
    await shot(page, "s8-alert-open");
    const fixtureRow = page
      .getByRole("listitem")
      .filter({ hasText: alertFixture.bin });
    await fixtureRow.getByRole("button", { name: "Acknowledge" }).click();
    const gone = await fixtureRow
      .waitFor({ state: "hidden", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    await page.locator("#alert-state").selectOption("acknowledged");
    const acknowledged = await waitVisible(
      page.getByRole("listitem").filter({ hasText: alertFixture.bin }),
    );
    check(
      "S8 admin acknowledges an alert through the gateway and UI refreshes",
      gone && acknowledged,
      `openViewRemoved=${gone} acknowledgedView=${acknowledged} responses=${JSON.stringify(alertResponses.map(({ status, payload }) => ({ status, errors: payload.errors?.map((e) => e.extensions?.code), items: payload.data?.alerts?.items?.map((item) => item.alertId), ack: payload.data?.acknowledgeAlert?.state })))}`,
    );
    await shot(page, "s8-alert-acknowledged");
  } finally {
    page.off("response", captureAlertResponse);
  }
}

async function scenarioLoading(alice) {
  const page = alice.page;
  await page.route("**/graphql", async (route) => {
    await delay(1500);
    await route.continue();
  });
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.fill("#device-search", `loading-${id}`);
  await page.getByRole("button", { name: "Search" }).click();
  const loadingStatus = page.getByRole("status").filter({
    hasText: "Searching devices",
  });
  const announced = await waitVisible(loadingStatus, 1000);
  const loading = announced ? await loadingStatus.textContent() : "";
  await shot(page, "s7-loading-state");
  await page.unroute("**/graphql");
  check(
    "S7 loading state is announced (role=status)",
    /Searching devices/.test(loading),
    `status="${loading}"`,
  );
}

async function bobProvision(bobToken) {
  const it = items.bob;
  const r = await gql(bobToken, operations.startProvisioning, {
    deviceId: it.device,
    assetId: it.asset,
    idempotencyKey: randomUUID(),
  });
  it.saga = r.body.data?.startProvisioning?.sagaId;
  check(
    "S5 bob (operator, tenant B) starts own provisioning through BFF",
    Boolean(it.saga),
    `saga=${it.saga} err=${code(r)}`,
  );
}

async function portFree(port, host = "127.0.0.1") {
  const probe = (await import("node:net")).createServer();
  return new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

async function stackUp() {
  mkdirSync(OUT, { recursive: true });
  for (const port of Object.values(PORTS).filter(
    (p) => p !== PORTS.deadRead && p !== PORTS.dashboard,
  ))
    if (!(await portFree(port))) throw new Error(`port ${port} is in use`);
  if (!(await portFree(PORTS.dashboard, "::1")))
    throw new Error("[::1]:5173 is in use");
  const incarnations = await controlIncarnations();
  sagaAdmissionContext = {
    shardId: "s1",
    shardIncarnation: incarnations.s1,
    placementEpoch: 1,
  };
  const tenantIds = Object.values(TENANT);
  await bootstrapTenantOwnership(
    tenantIds,
    ["inventory", "telemetry", "read", "sagas", "hardware", "alerts"],
    incarnations,
  );
  const placement = await startPlacementAuthority(incarnations);
  placement.add(...tenantIds);
  servers.push({ close: () => placement.close() });
  placementEnv = (service, database, directUrlEnv) => ({
    SHARD_REGISTRY_FILE: writeServiceRegistry({
      dir: path.join(tmp, "registry"),
      service,
      database,
      directUrl: process.env[directUrlEnv],
      incarnations,
    }),
    ...localShardSelection(),
    CONTROL_PLANE_URL: placement.url,
    CONTROL_LOOKUP_TOKEN: placement.token,
  });
  const fixtureFile = await seed();
  await offsets();
  const idp = (await import("node:http")).createServer((_q, s) =>
    s.writeHead(200, { "content-type": "application/json" }).end(issuer.jwks),
  );
  await S.listen(idp, PORTS.idp);
  servers.push(idp);
  const bins = buildAll();
  startBackends(bins, fixtureFile);
  // Private build: the shared apps/dashboard/dist can be rebuilt by other work mid-run.
  const dist = path.join(tmp, "dashboard-dist");
  const built = spawnSync(
    "npx",
    ["vite", "build", "--mode", "e2e", "--outDir", dist, "--emptyOutDir"],
    {
      cwd: "apps/dashboard",
      encoding: "utf8",
      env: {
        ...process.env,
        VITE_OIDC_AUTHORITY: ISSUER,
        VITE_OIDC_CLIENT_ID: "greenguard-dashboard",
        VITE_OIDC_AUDIENCE: "greenguard-dashboard",
      },
    },
  );
  if (built.status !== 0)
    throw new Error(`dashboard build: ${built.stderr.slice(-800)}`);
  const publicOidcConfig = {
    authority: ISSUER,
    clientId: "greenguard-dashboard",
    audience: "greenguard-dashboard",
    tokenMode: "audience",
  };
  const dashboard = S.dashboardServer(dist, PORTS.gateway, publicOidcConfig);
  await S.listen(dashboard.server, PORTS.dashboard, "::1");
  servers.push(dashboard.server);
  const configResponse = await fetch(`${DASHBOARD_SOCKET}/config.json`);
  assert.equal(configResponse.status, 200, "public OIDC config is served");
  assert.deepEqual(await configResponse.json(), publicOidcConfig);
  await waitFor(
    () => healthy(`http://127.0.0.1:${PORTS.sagaApi}/healthz`),
    "saga API",
    60_000,
  );
  await waitFor(
    () => healthy(`http://127.0.0.1:${PORTS.read}/healthz`),
    "Read API",
    60_000,
  );
  await waitFor(
    () => healthy(`http://127.0.0.1:${PORTS.bff}/healthz`),
    "BFF",
    60_000,
  );
  await waitFor(
    () => healthy(`http://127.0.0.1:${PORTS.bffDegraded}/healthz`),
    "degraded BFF",
    60_000,
  );
  await waitFor(
    () => healthy(`http://127.0.0.1:${PORTS.alerts}/readyz`),
    "alerts API",
    60_000,
  );
  await waitFor(
    () => healthy(`http://127.0.0.1:${PORTS.gateway}/readyz`),
    "gateway",
    60_000,
  );
  await waitFor(
    () => healthy(`http://127.0.0.1:${PORTS.gatewayDegraded}/healthz`),
    "degraded gateway",
    60_000,
  );
  await waitFor(
    () => healthy(`http://127.0.0.1:${PORTS.telemetry}/healthz`),
    "telemetry",
    60_000,
  );
  await aliasSearchIndex();
  return { bins, dashboard };
}

async function run() {
  let browser;
  try {
    const stack = await stackUp();
    browser = await chromium.launch();
    const alice = await newUser(browser, "alice");
    const victor = await newUser(browser, "victor");
    const signInPage = await (await browser.newContext()).newPage();
    await signInPage.goto(DASHBOARD);
    await alice.page
      .getByRole("link", { name: "Devices", exact: true })
      .click();
    await alice.page.fill("#device-search", "warmup");
    await alice.page.getByRole("button", { name: "Search" }).click();
    await waitFor(() => alice.token(), "alice bearer captured", 15_000);
    await victor.page
      .getByRole("link", { name: "Devices", exact: true })
      .click();
    await victor.page.fill("#device-search", "warmup");
    await victor.page.getByRole("button", { name: "Search" }).click();
    await waitFor(() => victor.token(), "victor bearer captured", 15_000);
    await preflight(alice.token());
    const bobTokens = await (
      await import("./oidc-login.mjs")
    ).login({ email: "bob@greenguard.test", password });
    await scenarioProvision(alice);
    await scenarioReload(browser, alice);
    await bobProvision(bobTokens.access_token);
    await scenarioRepair(alice, victor.token(), stack.bins);
    await scenarioReads(alice);
    await scenarioRedisOutage(alice, bobTokens.access_token);
    await scenarioAlerts(alice, victor, bobTokens.access_token);
    const bob = await scenarioIsolation(
      browser,
      bobTokens.access_token,
      victor,
    );
    const pages = [["sign-in", signInPage]];
    const a11yPage = alice.page;
    for (const [name, link] of [
      ["home", null],
      ["provisioning", "Provisioning"],
      ["devices", "Devices"],
    ]) {
      if (link)
        await a11yPage.getByRole("link", { name: link, exact: true }).click();
      else await a11yPage.getByRole("link", { name: "GreenGuard" }).click();
      await delay(500);
      const ctxPage = await snapshotPage(browser, a11yPage, name);
      pages.push([name, ctxPage]);
    }
    await scenarioA11y(pages);
    await scenarioLoading(alice);
    await scenarioDegraded(alice, stack.dashboard);
    await bob.context.close();
  } finally {
    await browser?.close();
    for (const server of servers) server.close();
  }
}

// Clone the live DOM into a static page so the a11y checks see the signed-in view.
async function snapshotPage(browser, page, name) {
  const html = await page.content();
  const p = await (await browser.newContext()).newPage();
  await p.setContent(html);
  await p.evaluate((t) => {
    document.title = document.title || t;
  }, name);
  return p;
}

async function main() {
  const started = Date.now();
  acquireRunLock();
  mkdirSync(OUT, { recursive: true });
  try {
    await run();
  } catch (error) {
    // Node's fetch hides the real reason (code, address, port) in error.cause.
    const cause = error.cause
      ? ` (cause: ${error.cause.code ?? ""} ${error.cause.address ?? ""}:${error.cause.port ?? ""} ${error.cause.message ?? ""})`
      : "";
    failures.push(`harness: ${error.message}${cause}`);
    console.log(`FAIL harness :: ${error.stack}${cause}`);
    for (const [name, log] of S.logs)
      console.log(`--- ${name} ---\n${log.slice(-1500)}`);
  } finally {
    await S.stopAll();
    await fetch(`http://127.0.0.1:19200/${alias}-v1`, {
      method: "DELETE",
    }).catch(() => undefined);
    for (const [name, log] of S.logs)
      writeFileSync(
        `${OUT}/${name}.log`,
        log.replaceAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>"),
      );
    rmSync(tmp, { recursive: true, force: true });
  }
  const reportPath = `${OUT}/report.md`;
  writeFileSync(
    reportPath,
    [
      "# Stage 08 browser E2E",
      "",
      `Run: ${new Date(started).toISOString()}`,
      `Result: ${failures.length ? "FAIL" : "PASS"}`,
      `Duration: ${Math.round((Date.now() - started) / 1000)} seconds`,
      "",
      "## Checks",
      "",
      ...results.map((line) => `- ${line}`),
      ...(failures.length
        ? ["", "## Failures", "", ...failures.map((name) => `- ${name}`)]
        : []),
      "",
    ].join("\n"),
  );
  copyFileSync(reportPath, `${OUT_BASE}/latest-attempt.md`);
  if (failures.length === 0) copyFileSync(reportPath, `${OUT_BASE}/report.md`);
  unlinkSync(LOCK);
  console.log(
    `${failures.length ? `FAILED (${failures.length}): ${failures.join("; ")}` : "ALL BROWSER E2E CHECKS PASSED"} in ${Math.round((Date.now() - started) / 1000)} s`,
  );
  process.exitCode = failures.length ? 1 : 0;
}

await main();
