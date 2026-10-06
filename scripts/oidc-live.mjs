// Stage 08 live OIDC proof (ADR-0014). Run with `make oidc-test` (needs Dex from
// `make oidc-up`, the dev Postgres/PgBouncer, Cassandra and Elasticsearch).
// Starts real BFF and Read API processes that verify Dex tokens through JWKS and
// map identity to tenant/roles via infra/oidc/memberships.json. Never prints tokens.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { SignJWT, generateKeyPair, importJWK, exportSPKI } from "jose";
import { createTokenVerifierFromEnv } from "@greenguard/tenant-auth";
import { ISSUER, decodeJwt, login, refresh } from "./oidc-login.mjs";

const TENANT = {
  a: "0a0a0a0a-0000-4000-8000-00000000000a",
  b: "0b0b0b0b-0000-4000-8000-00000000000b",
};
const DEVICE = {
  a: "0a0a0a0a-1111-4000-8000-00000000000a",
  b: "0b0b0b0b-1111-4000-8000-00000000000b",
};
const SITE = "5a5a5a5a-2222-4000-8000-000000000005";
const BFF = process.env.OIDC_BFF_URL ?? "http://127.0.0.1:4100";
const READ = "http://127.0.0.1:4101";
const COMPOSE = [
  "compose",
  "--env-file",
  ".env",
  "-f",
  "infra/oidc/compose.yaml",
];
const CACHE_MS = 20_000;
const TOLERANCE_SEC = 5;
const COOLDOWN_MS = 2000;
const password = process.env.OIDC_DEV_PASSWORD;
const failures = [];

function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
  if (!ok) failures.push(name);
}

const authEnv = {
  AUTH_ISSUER: ISSUER,
  AUTH_AUDIENCE: "greenguard-dashboard",
  AUTH_JWKS_URL: `${ISSUER}/keys`,
  AUTH_MEMBERSHIP_FILE: "infra/oidc/memberships.json",
  AUTH_JWKS_CACHE_MS: String(CACHE_MS),
  AUTH_JWKS_COOLDOWN_MS: String(COOLDOWN_MS),
  AUTH_CLOCK_TOLERANCE_SEC: String(TOLERANCE_SEC),
};

function psql(sql) {
  execFileSync("docker", [
    "exec",
    "greenguard-dev-postgres-1",
    "psql",
    "-U",
    "postgres",
    "-d",
    "greenguard_read",
    "-v",
    "ON_ERROR_STOP=1",
    "-qc",
    sql,
  ]);
}

// The tenant-ownership row fence rejects direct writes without a bootstrapped
// shard placement. This test seeds and removes fixture rows as the PostgreSQL
// superuser, so it bypasses row triggers for that one transaction only; the
// services under test keep the fence enabled.
function asFixture(statement) {
  return `SET LOCAL session_replication_role = replica; ${statement}`;
}

function seed() {
  cleanup();
  psql(
    asFixture(
      "INSERT INTO public.device_views(tenant_id,device_id,site_id,serial_number,status,inventory_version) VALUES " +
        `('${TENANT.a}','${DEVICE.a}','${SITE}','oidc-a','active',1),` +
        `('${TENANT.b}','${DEVICE.b}','${SITE}','oidc-b','active',1)`,
    ),
  );
}

function cleanup() {
  psql(
    asFixture(
      `DELETE FROM public.device_views WHERE (tenant_id,device_id) IN (('${TENANT.a}','${DEVICE.a}'),('${TENANT.b}','${DEVICE.b}'))`,
    ),
  );
}

function start(script, env) {
  const child = spawn("node", [script], {
    env: { ...process.env, ...authEnv, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) =>
    process.stderr.write(`[${script}] ${chunk}`),
  );
  return child;
}

async function waitHealthy(base) {
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`${base}/healthz`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`${base} not healthy`);
}

const hash = (query) => createHash("sha256").update(query).digest("hex");
// Use the BFF's own persisted operations so this test cannot drift from the allowlist.
const { operations } = await import("../services/bff/dist/query-policy.js");
const DEVICE_CURRENT = operations.deviceCurrent;
const START = operations.startProvisioning;

async function graphql(token, query, variables) {
  const response = await fetch(`${BFF}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash(query) } },
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function readApi(token, deviceId) {
  const response = await fetch(`${READ}/api/v1/read/devices/${deviceId}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

const bffDevice = (token, id) => graphql(token, DEVICE_CURRENT, { id });
const deviceOf = (result) => result.body?.data?.device?.deviceId ?? null;

async function forge(payload, header, key) {
  return new SignJWT(payload).setProtectedHeader(header).sign(key);
}

async function dexPublicKey(kid) {
  const { keys } = await fetch(`${ISSUER}/keys`).then((r) => r.json());
  return importJWK(keys.find((k) => k.kid === kid) ?? keys[0], "RS256");
}

async function acceptanceAndIsolation(tokens) {
  const { alice, bob, victor } = tokens;
  const own = await bffDevice(alice.access_token, DEVICE.a);
  check(
    "BFF valid Dex token accepted (alice, tenant A)",
    deviceOf(own) === DEVICE.a,
    `HTTP ${own.status} device=${deviceOf(own)}`,
  );
  const ownRead = await readApi(alice.access_token, DEVICE.a);
  check(
    "Read API valid Dex token accepted",
    ownRead.status === 200 && ownRead.body.data?.tenant_id === TENANT.a,
    `HTTP ${ownRead.status} tenant=${ownRead.body.data?.tenant_id}`,
  );
  const cross = await bffDevice(alice.access_token, DEVICE.b);
  check(
    "BFF tenant A cannot read tenant B device",
    deviceOf(cross) === null,
    `HTTP ${cross.status} device=${deviceOf(cross)}`,
  );
  const crossRead = await readApi(alice.access_token, DEVICE.b);
  check(
    "Read API tenant A cannot read tenant B device",
    crossRead.body.data == null,
    `HTTP ${crossRead.status} data=${JSON.stringify(crossRead.body.data ?? null)}`,
  );
  const bobOwn = await bffDevice(bob.access_token, DEVICE.b);
  const bobCross = await readApi(bob.access_token, DEVICE.a);
  check(
    "tenant B reads only tenant B",
    deviceOf(bobOwn) === DEVICE.b && bobCross.body.data == null,
    `own=${deviceOf(bobOwn)} crossHTTP=${bobCross.status}`,
  );
  const viewerMutation = await graphql(victor.access_token, START, {
    deviceId: DEVICE.a,
    assetId: SITE,
    idempotencyKey: "oidc-live-viewer",
  });
  const viewerCode =
    viewerMutation.body.errors?.[0]?.extensions?.code ??
    viewerMutation.body.errors?.[0]?.message;
  check(
    "viewer cannot run a mutation",
    viewerMutation.body.data == null &&
      /insufficient_role|FORBIDDEN/i.test(String(viewerCode)),
    `HTTP ${viewerMutation.status} error=${viewerCode}`,
  );
  const operatorMutation = await graphql(bob.access_token, START, {
    deviceId: DEVICE.b,
    assetId: SITE,
    idempotencyKey: "oidc-live-operator",
  });
  const opCode =
    operatorMutation.body.errors?.[0]?.extensions?.code ??
    operatorMutation.body.errors?.[0]?.message;
  check(
    "operator passes the role gate (saga stub unreachable)",
    !/insufficient_role/.test(String(opCode)),
    `error=${opCode}`,
  );
}

async function rejections(alice) {
  const payload = decodeJwt(alice.access_token);
  const header = JSON.parse(
    Buffer.from(alice.access_token.split(".")[0], "base64url"),
  );
  const attacker = (await generateKeyPair("RS256")).privateKey;
  const cases = [];
  const other = await login({
    email: "alice@greenguard.test",
    password,
    clientId: "greenguard-cli",
    redirectUri: "http://127.0.0.1:8765/callback",
  });
  cases.push([
    "wrong audience (real Dex token for greenguard-cli)",
    other.access_token,
    401,
    "invalid_token",
  ]);
  cases.push([
    "wrong signature (payload re-signed by attacker, Dex kid)",
    await forge(payload, header, attacker),
    401,
    "invalid_token",
  ]);
  const [h, p] = alice.access_token.split(".");
  const tampered = Buffer.from(
    JSON.stringify({ ...payload, sub: "Cgh1c2VyLWJvYhIFbG9jYWw" }),
  ).toString("base64url");
  cases.push([
    "tampered payload with original signature",
    `${h}.${tampered}.${alice.access_token.split(".")[2]}`,
    401,
    "invalid_token",
  ]);
  cases.push([
    "wrong issuer (forged iss)",
    await forge({ ...payload, iss: "http://evil.test/dex" }, header, attacker),
    401,
    "invalid_token",
  ]);
  const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.`;
  cases.push(["alg=none", none, 401, "invalid_token"]);
  const pem = await exportSPKI(await dexPublicKey(header.kid));
  const hs = await forge(
    payload,
    { alg: "HS256", kid: header.kid },
    new TextEncoder().encode(pem),
  );
  cases.push([
    "HS256 signed with the Dex public key",
    hs,
    401,
    "invalid_token",
  ]);
  cases.push([
    "unknown kid (bounded refresh, then 401)",
    await forge(payload, { alg: "RS256", kid: "unknown-kid" }, attacker),
    401,
    "invalid_token",
  ]);
  cases.push(["missing token", "", 401, "missing_token"]);
  for (const [name, token, status, code] of cases) {
    const bff = await bffDevice(token, DEVICE.a);
    const read = await readApi(token, DEVICE.a);
    check(
      `reject ${name}`,
      bff.status === status && bff.body.code === code && read.status === status,
      `BFF ${bff.status} ${bff.body.code}; Read API ${read.status} ${read.body.code}`,
    );
  }
}

async function libraryProofs(alice) {
  const env = { ...authEnv, AUTH_ISSUER: "http://localhost:5556/dex" };
  const wrongIssuer = createTokenVerifierFromEnv(
    (k) => env[k],
    (f) => execFileSync("cat", [f], { encoding: "utf8" }),
  );
  const outcome = await wrongIssuer.verify(`Bearer ${alice.access_token}`).then(
    () => "accepted",
    (e) => `${e.status} ${e.code}`,
  );
  check(
    "genuine Dex signature but unexpected issuer rejected",
    outcome === "401 invalid_token",
    outcome,
  );
  const realFetch = globalThis.fetch;
  let jwksFetches = 0;
  globalThis.fetch = (url, init) => {
    if (String(url).endsWith("/keys")) jwksFetches++;
    return realFetch(url, init);
  };
  try {
    const counted = createTokenVerifierFromEnv(
      (k) => authEnv[k],
      (f) => execFileSync("cat", [f], { encoding: "utf8" }),
    );
    await counted.verify(`Bearer ${alice.access_token}`);
    await sleep(COOLDOWN_MS + 200);
    const attacker = (await generateKeyPair("RS256")).privateKey;
    const unknown = await forge(
      decodeJwt(alice.access_token),
      { alg: "RS256", kid: "rotated-away" },
      attacker,
    );
    const codes = [];
    for (let i = 0; i < 5; i++)
      codes.push(
        await counted.verify(`Bearer ${unknown}`).then(
          () => "ok",
          (e) => e.code,
        ),
      );
    check(
      "unknown kid refresh is bounded by the cooldown",
      jwksFetches === 2 && codes.every((c) => c === "invalid_token"),
      `5 unknown-kid verifications -> ${codes.join(",")}; JWKS fetches=${jwksFetches} (1 initial + exactly 1 kid-miss refresh; the rest fall inside the ${COOLDOWN_MS}ms cooldown)`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

function dex(...args) {
  execFileSync("docker", [...COMPOSE, ...args], {
    stdio: "ignore",
    env: process.env,
  });
}

async function outageWindow(alice) {
  const attacker = (await generateKeyPair("RS256")).privateKey;
  const unknown = await forge(
    decodeJwt(alice.access_token),
    { alg: "RS256", kid: "needs-refresh" },
    attacker,
  );
  // Anchor the cache: after the cooldown a kid miss forces one JWKS reload.
  await sleep(COOLDOWN_MS + 200);
  await bffDevice(unknown, DEVICE.a);
  await readApi(unknown, DEVICE.a);
  const cachedAt = Date.now();
  dex("stop", "dex");
  const cached = await bffDevice(alice.access_token, DEVICE.a);
  check(
    "JWKS down: cached key still verifies inside the stale window",
    deviceOf(cached) === DEVICE.a,
    `HTTP ${cached.status} at +${Date.now() - cachedAt}ms`,
  );
  const cooling = await bffDevice(unknown, DEVICE.a);
  check(
    "JWKS down: kid miss inside the cooldown does not hit the key server",
    cooling.status === 401,
    `HTTP ${cooling.status} ${cooling.body.code}`,
  );
  await sleep(COOLDOWN_MS + 200);
  const miss = await bffDevice(unknown, DEVICE.a);
  check(
    "JWKS down: kid miss needs the key server -> 503",
    miss.status === 503 && miss.body.code === "auth_unavailable",
    `HTTP ${miss.status} ${miss.body.code}`,
  );
  await sleep(CACHE_MS + 1500 - (Date.now() - cachedAt));
  const stale = await bffDevice(alice.access_token, DEVICE.a);
  const staleRead = await readApi(alice.access_token, DEVICE.a);
  check(
    "JWKS down past the bounded window -> 503 auth_unavailable",
    stale.status === 503 &&
      stale.body.code === "auth_unavailable" &&
      staleRead.status === 503,
    `BFF ${stale.status} ${stale.body.code}; Read API ${staleRead.status} ${staleRead.body.code} at +${Date.now() - cachedAt}ms (window ${CACHE_MS}ms)`,
  );
}

async function rotationAndExpiry(oldAlice) {
  const oldKid = JSON.parse(
    Buffer.from(oldAlice.access_token.split(".")[0], "base64url"),
  ).kid;
  execFileSync(
    "docker",
    [...COMPOSE, "up", "-d", "--wait", "--force-recreate"],
    { stdio: "ignore", env: { ...process.env, OIDC_TOKEN_TTL: "30s" } },
  );
  const fresh = await login({ email: "alice@greenguard.test", password });
  const newKid = JSON.parse(
    Buffer.from(fresh.access_token.split(".")[0], "base64url"),
  ).kid;
  const accepted = await bffDevice(fresh.access_token, DEVICE.a);
  check(
    "key rotation: new-key token accepted after JWKS refresh",
    newKid !== oldKid && deviceOf(accepted) === DEVICE.a,
    `old kid ${oldKid.slice(0, 8)} -> new kid ${newKid.slice(0, 8)}; HTTP ${accepted.status}`,
  );
  const retired = await bffDevice(oldAlice.access_token, DEVICE.a);
  check(
    "key rotation: token signed by the removed key rejected",
    retired.status === 401,
    `HTTP ${retired.status} ${retired.body.code}`,
  );
  const exp = decodeJwt(fresh.access_token).exp * 1000;
  await sleep(Math.max(0, exp + TOLERANCE_SEC * 1000 + 1500 - Date.now()));
  const expired = await bffDevice(fresh.access_token, DEVICE.a);
  const expiredRead = await readApi(fresh.access_token, DEVICE.a);
  check(
    "expired Dex token rejected",
    expired.status === 401 &&
      expired.body.code === "expired_token" &&
      expiredRead.body.code === "expired_token",
    `BFF ${expired.status} ${expired.body.code}; Read API ${expiredRead.status} ${expiredRead.body.code}`,
  );
  const renewed = await refresh(fresh.refresh_token);
  const afterRenew = await bffDevice(renewed.access_token, DEVICE.a);
  check(
    "refresh-token renewal restores access",
    deviceOf(afterRenew) === DEVICE.a,
    `HTTP ${afterRenew.status}`,
  );
}

export function startStack() {
  seed();
  const read = start("services/read-api/dist/main.js", {
    READ_API_PORT: "4101",
    CASSANDRA_HOSTS: "127.0.0.1:59042",
    ELASTICSEARCH_URL: "http://127.0.0.1:19200",
    READ_REDIS_URL: "",
    READ_REDIS_CLUSTER_NODES: "",
  });
  const bff = start("services/bff/dist/main.js", {
    BFF_PORT: new URL(BFF).port,
    SAGA_API_URL: "http://127.0.0.1:4199",
    READ_API_URL: READ,
    BFF_RATE_REDIS_URL: "",
    BFF_RATE_REDIS_CLUSTER_NODES: "",
    BFF_ALLOW_NO_RATE_LIMIT: "true",
  });
  const stop = () => {
    for (const child of [bff, read]) {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }
    cleanup();
  };
  const ready = Promise.all([waitHealthy(READ), waitHealthy(BFF)]);
  return { ready, stop };
}

async function main() {
  const stack = startStack();
  try {
    await stack.ready;
    const tokens = {};
    for (const user of ["alice", "victor", "bob"])
      tokens[user] = await login({
        email: `${user}@greenguard.test`,
        password,
      });
    check(
      "authorization code + PKCE login (state and nonce validated)",
      Object.keys(tokens).length === 3,
      "alice, victor (tenant A) and bob (tenant B)",
    );
    await acceptanceAndIsolation(tokens);
    await rejections(tokens.alice);
    await libraryProofs(tokens.alice);
    await outageWindow(tokens.alice);
    await rotationAndExpiry(tokens.alice);
  } finally {
    stack.stop();
    execFileSync(
      "docker",
      [...COMPOSE, "up", "-d", "--wait", "--force-recreate"],
      { stdio: "ignore" },
    );
  }
  console.log(
    failures.length
      ? `FAILED: ${failures.join("; ")}`
      : "ALL OIDC CHECKS PASSED",
  );
  process.exitCode = failures.length ? 1 : 0;
}

export { bffDevice, deviceOf, readApi, check, failures, DEVICE, TENANT };

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
