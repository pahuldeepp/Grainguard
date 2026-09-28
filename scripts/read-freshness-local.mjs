#!/usr/bin/env node
// Isolated acceptance resources only; no shared .env, databases or Redis keys.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(resolve(tmpdir(), "gg-freshness-"));
const suffix = randomBytes(6).toString("hex");
const postgres = `gg-read-leases-${suffix}`,
  redis = `gg-watermark-cache-${suffix}`;
const environment = { ...process.env };
const sql = readFileSync(
  resolve(root, "infra/compose/init-databases.sql"),
  "utf8",
);
const secretKeys = new Set([
  "POSTGRES_PASSWORD",
  ...Array.from(sql.matchAll(/\\getenv\s+\w+\s+(\w+)/g), (m) => m[1]),
]);
for (const key of secretKeys)
  environment[key] = randomBytes(24).toString("hex");
const secretFile = resolve(scratch, "compose.env");
writeFileSync(
  secretFile,
  [...secretKeys].map((key) => `${key}=${environment[key]}`).join("\n") + "\n",
  { mode: 0o600 },
);
const created = [];
function redact(text) {
  let out = text;
  for (const key of secretKeys)
    out = out.replaceAll(environment[key], "[redacted]");
  return out;
}
function run(command, args, env = environment) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(redact(result.stdout));
  if (result.stderr) process.stderr.write(redact(result.stderr));
  if (result.error || result.status !== 0)
    throw new Error(`${command} exited unsuccessfully`);
  return result.stdout.trim();
}
function docker(args) {
  const result = spawnSync("docker", args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(redact(result.stderr));
  return result.stdout.trim();
}
const url = (role, password, database, port) => {
  const endpoint = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  endpoint.username = role;
  endpoint.password = password;
  return endpoint.toString();
};
try {
  docker([
    "run",
    "-d",
    "--name",
    postgres,
    "--env-file",
    secretFile,
    "-p",
    "127.0.0.1::5432",
    "-v",
    `${resolve(root, "infra/compose/init-databases.sql")}:/docker-entrypoint-initdb.d/001-init.sql:ro`,
    "postgres:16",
    "-c",
    "wal_level=logical",
  ]);
  created.push(postgres);
  const pgPort = docker(["port", postgres, "5432/tcp"]).split(":").at(-1);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const client = new pg.Client({
      connectionString: url(
        "control_migrator",
        environment.CONTROL_MIGRATOR_PASSWORD,
        "greenguard_control",
        pgPort,
      ),
      connectionTimeoutMillis: 500,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      ready = true;
      break;
    } catch {
      /* PostgreSQL bootstrap is retried until the readiness deadline. */
    } finally {
      await client.end().catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready)
    throw new Error("isolated PostgreSQL bootstrap did not become ready");
  environment.CONTROL_MIGRATION_URL = url(
    "control_migrator",
    environment.CONTROL_MIGRATOR_PASSWORD,
    "greenguard_control",
    pgPort,
  );
  environment.CONTROL_DATABASE_URL = environment.CONTROL_DIRECT_URL = url(
    "control_app",
    environment.CONTROL_DB_PASSWORD,
    "greenguard_control",
    pgPort,
  );
  environment.POSTGRES_ADMIN_URL = url(
    "postgres",
    environment.POSTGRES_PASSWORD,
    "postgres",
    pgPort,
  );
  run("npm", ["run", "migrate", "-w", "@greenguard/tenant-control-plane"]);
  run("node", [
    "--test",
    "services/tenant-control-plane/dist/domain/read-leases.test.js",
  ]);
  run("node", [
    "--test",
    "services/tenant-control-plane/dist/api/placement.test.js",
  ]);
  environment.RISK_MIGRATION_URL =
    environment.RISK_SHARD_ACCEPTANCE_MIGRATOR_URL = url(
      "risk_migrator",
      environment.RISK_MIGRATOR_PASSWORD,
      "greenguard_risk",
      pgPort,
    );
  environment.RISK_SHARD_ACCEPTANCE_URL = url(
    "risk_app",
    environment.RISK_DB_PASSWORD,
    "greenguard_risk",
    pgPort,
  );
  run(".local/risk-venv/bin/python", ["-m", "risk_engine.migrate"], {
    ...environment,
    PYTHONPATH: resolve(root, "services/risk-engine"),
  });
  run(".local/risk-venv/bin/python", [
    "-m",
    "unittest",
    "discover",
    "-s",
    "services/risk-engine",
    "-p",
    "test_shards_live.py",
    "-v",
  ]);
  environment.PROJECTION_MIGRATION_URL = url(
    "projection_migrator",
    environment.PROJECTION_MIGRATOR_PASSWORD,
    "greenguard_read",
    pgPort,
  );
  environment.FRESHNESS_PG_ADMIN_URL = url(
    "postgres",
    environment.POSTGRES_PASSWORD,
    "greenguard_read",
    pgPort,
  );
  environment.FRESHNESS_PG_QUERY_URL = url(
    "read_query",
    environment.READ_QUERY_DB_PASSWORD,
    "greenguard_read",
    pgPort,
  );
  run("go", ["-C", "services/projection-builder", "run", "./cmd/migrate"]);
  run("node", ["--test", "services/read-api/dist/replicas.live.test.js"]);
  docker([
    "run",
    "-d",
    "--name",
    redis,
    "-p",
    "127.0.0.1::6379",
    "redis:7.4.7-alpine",
  ]);
  created.push(redis);
  const redisPort = docker(["port", redis, "6379/tcp"]).split(":").at(-1);
  environment.FRESHNESS_REDIS_URL = `redis://127.0.0.1:${redisPort}`;
  run("node", [
    "--test",
    "services/read-api/dist/watermark-cache.live.test.js",
  ]);
  run(
    "go",
    [
      "-C",
      "services/cache-invalidator",
      "test",
      "./...",
      "-run",
      "TestWatermark",
      "-count=1",
    ],
    { ...environment, READ_REDIS_URL: environment.FRESHNESS_REDIS_URL },
  );
  console.log(
    "Isolated read lease and Redis watermark acceptance passed; scratch containers will be removed.",
  );
} finally {
  for (const name of created.reverse()) docker(["rm", "-f", name]);
  rmSync(scratch, { recursive: true, force: true });
}
