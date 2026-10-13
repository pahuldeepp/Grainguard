// Process stack for the Stage 08 browser E2E (scripts/browser-e2e.mjs). Starts the
// real saga API/worker, participants, event pipeline, Read API, BFF, gateways and a static
// dashboard server on private ports. It never stops shared containers.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import kafkaJs from "kafkajs";
import pg from "pg";

export const broker = "127.0.0.1:59092";
export const PORTS = {
  sagaApi: 18292,
  idp: 18294,
  telemetry: 18297,
  cdc: 18298,
  cassandraWriter: 18299,
  read: 4301,
  bff: 4300,
  bffDegraded: 4302,
  gateway: 4303,
  gatewayDegraded: 4304,
  gatewayMetrics: 19464,
  gatewayDegradedMetrics: 19465,
  alerts: 4305,
  searchHealth: 18300,
  deadRead: 4309,
  dashboard: 5173,
};
const children = [];
export const logs = new Map();

export function makeIssuer(id) {
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
  const iss = `https://browser-e2e-${id}.greenguard.invalid/`;
  const token = (claims) => {
    const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: "RS256", typ: "JWT", kid: id })}.${b64({
      iss,
      iat: now,
      exp: now + 3600,
      ...claims,
    })}`;
    return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
  };
  return { iss, jwks, token };
}

export function listen(server, port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

export function buildGo(tmp, module, target, name) {
  const output = path.join(tmp, name);
  const result = spawnSync("go", ["build", "-o", output, target], {
    cwd: module,
    encoding: "utf8",
    timeout: 240_000,
  });
  assert.equal(
    result.status,
    0,
    `${name} build: ${result.stderr?.slice(-1500)}`,
  );
  return output;
}

export function start(name, command, args, cwd, env = {}) {
  const p = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const keep = (chunk) => {
    log = (log + chunk.toString()).slice(-20_000);
    logs.set(name, log);
  };
  p.stdout.on("data", keep);
  p.stderr.on("data", keep);
  p.on("exit", (code, signal) =>
    logs.set(name, `${log}\n[exit code=${code} signal=${signal}]`),
  );
  children.push(p);
  return p;
}

export async function stop(p) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  const closed = new Promise((resolve) => p.once("close", resolve));
  p.kill("SIGTERM");
  await Promise.race([closed, delay(7000).then(() => p.kill("SIGKILL"))]);
}

export async function stopAll() {
  for (const child of children.reverse()) await stop(child);
}

export async function waitFor(predicate, label, timeoutMs = 120_000) {
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
  throw new Error(`${label} timed out: ${last?.message ?? "no match"}`);
}

export function placementSessionSettings(placement) {
  if (
    !placement ||
    placement.shardId !== "s1" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      placement.shardIncarnation,
    ) ||
    !Number.isSafeInteger(placement.placementEpoch) ||
    placement.placementEpoch < 1
  ) {
    throw new Error("invalid trusted fixture placement context");
  }
  return [
    ["app.shard_id", placement.shardId],
    ["app.shard_incarnation", placement.shardIncarnation],
    ["app.placement_epoch", String(placement.placementEpoch)],
  ];
}

export async function scoped(url, tenant, work, fixture = false, placement) {
  // Fixture writes run as the PostgreSQL superuser with the tenant-ownership row
  // fence bypassed for that transaction, then switch back to the service role so
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
    if (placement) {
      for (const [setting, value] of placementSessionSettings(placement)) {
        await db.query("SELECT set_config($1,$2,true)", [setting, value]);
      }
    }
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
export const fixtureScoped = (url, tenant, work) =>
  scoped(url, tenant, work, true);

// Seed each group to the topic end only when it has never committed, so a
// fresh private group does not replay other runs' backlog. Shared groups that
// already have offsets are left untouched.
export async function seedOffsets(groups) {
  const kafka = new kafkaJs.Kafka({
    clientId: "browser-e2e-admin",
    brokers: [broker],
    logLevel: kafkaJs.logLevel.NOTHING,
  });
  const admin = kafka.admin();
  await admin.connect();
  try {
    for (const [groupId, topics, force] of groups) {
      if (force)
        await waitFor(
          async () =>
            ["Empty", "Dead"].includes(
              (await admin.describeGroups([groupId])).groups[0].state,
            ),
          `consumer group ${groupId} has no running members`,
          90_000,
        );
      const committed = await admin.fetchOffsets({ groupId, topics });
      for (const { topic, partitions } of committed) {
        if (!force && partitions.some((p) => Number(p.offset) >= 0)) continue;
        const high = await admin.fetchTopicOffsets(topic);
        await admin.setOffsets({
          groupId,
          topic,
          partitions: high.map((p) => ({
            partition: p.partition,
            offset: p.high,
          })),
        });
      }
    }
  } finally {
    await admin.disconnect();
  }
}

export const cellFor = (tenants) =>
  createHash("sha256")
    .update([...tenants].sort().join(","))
    .digest("hex")
    .slice(0, 16);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

// Serves the built dashboard like apps/dashboard/nginx.conf: SPA fallback plus
// `location = /graphql` proxied to the gateway. The target can be switched to a
// second gateway/BFF pair to simulate a Read API outage without touching shared services.
export function dashboardServer(root, target, publicOidcConfig) {
  const state = { target };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/config.json" && req.method === "GET") {
      if (!publicOidcConfig) {
        res.writeHead(404, { "cache-control": "no-store" }).end();
        return;
      }
      res
        .writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        })
        .end(JSON.stringify(publicOidcConfig));
      return;
    }
    if (
      url.pathname === "/graphql" ||
      url.pathname === "/api/v1/subscription-ticket"
    ) {
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: state.target,
          path: url.pathname,
          method: req.method,
          headers: req.headers,
        },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => res.writeHead(502).end());
      req.pipe(upstream);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(503, { "content-type": "text/plain" }).end("not started");
      return;
    }
    const file = path.join(root, path.normalize(url.pathname));
    const chosen =
      file.startsWith(root) && existsSync(file) && statSync(file).isFile()
        ? file
        : path.join(root, "index.html");
    res.writeHead(200, {
      "content-type": types[path.extname(chosen)] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    createReadStream(chosen).pipe(res);
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/graphql") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: state.target,
      path: "/graphql",
      method: "GET",
      headers: req.headers,
    });
    upstream.once("upgrade", (response, peer, peerHead) => {
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (const [key, value] of Object.entries(response.headers))
        if (value !== undefined) lines.push(`${key}: ${value}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) peer.write(head);
      if (peerHead.length) socket.write(peerHead);
      socket.once("close", () => peer.destroy());
      peer.once("close", () => socket.destroy());
      socket.pipe(peer).pipe(socket);
    });
    upstream.once("response", (response) => {
      socket.end(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`,
      );
      response.resume();
    });
    upstream.once("error", () => socket.destroy());
    upstream.end();
  });
  return { server, state };
}
