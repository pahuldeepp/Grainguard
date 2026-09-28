#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = {
  ...parseEnv(readFileSync(resolve(root, ".env"), "utf8")),
  ...process.env,
};
const composeSecretFile = resolve(root, ".local/sharding/compose.env");
mkdirSync(dirname(composeSecretFile), { recursive: true, mode: 0o700 });
if (!existsSync(composeSecretFile)) {
  writeFileSync(
    composeSecretFile,
    `GG_REPLICATION_PASSWORD=${randomBytes(32).toString("hex")}\n`,
    { mode: 0o600, flag: "wx" },
  );
}
chmodSync(composeSecretFile, 0o600);
Object.assign(environment, parseEnv(readFileSync(composeSecretFile, "utf8")));
const shardIds = ["s1", "s2", "s3", "s4"];
const owners = [
  ["inventory", "inventory", "INVENTORY", "device-service", "node"],
  ["telemetry", "telemetry", "TELEMETRY", "telemetry-ingest", "go"],
  ["projection", "read", "PROJECTION", "projection-builder", "go"],
  ["risk", "risk", "RISK", "risk-engine", "python"],
  ["alerts", "alerts", "ALERTS", "workflow-alerts", "node"],
  ["jobs", "jobs", "JOBS", "jobs-worker", "go"],
  [
    "notifications",
    "notifications",
    "NOTIFICATIONS",
    "notification-service",
    "node",
  ],
  ["saga", "sagas", "SAGA", "saga-orchestrator", "go"],
  ["hardware", "hardware", "HARDWARE", "hardware-service", "go"],
];
const project = environment.GG_SHARD_COMPOSE_PROJECT ?? "greenguard-sharding";
if (!/^greenguard-sharding(?:-[a-z0-9-]+)?$/.test(project))
  throw new Error(
    "GG_SHARD_COMPOSE_PROJECT must name an isolated greenguard-sharding project",
  );
const compose = [
  "compose",
  "-p",
  project,
  "--env-file",
  ".env",
  "--env-file",
  ".local/sharding/compose.env",
  "-f",
  "infra/compose/shards.compose.yaml",
  "--profile",
  "sharding",
];

function run(command, args, cwd = root, env = environment) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
}
function url(shardIndex, role, passwordKey, database, replica = false) {
  const password = environment[passwordKey];
  if (!password) throw new Error(`${passwordKey} is required`);
  const endpoint = new URL("postgresql://127.0.0.1");
  endpoint.username = role;
  endpoint.password = password;
  endpoint.port = String((replica ? 58431 : 57431) + shardIndex);
  endpoint.pathname =
    database === "postgres" ? "/postgres" : `/greenguard_${database}`;
  endpoint.searchParams.set("sslmode", "disable");
  return endpoint.toString();
}
function pool(shardIndex, role, passwordKey, database, replica = false) {
  return new pg.Pool({
    connectionString: url(shardIndex, role, passwordKey, database, replica),
    max: 1,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  });
}
async function tenantQuery(pool, tenant, sql, values = [], placement) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    if (placement) {
      await client.query("SELECT set_config('app.shard_id',$1,true)", [
        placement.shardId,
      ]);
      await client.query("SELECT set_config('app.shard_incarnation',$1,true)", [
        placement.incarnation,
      ]);
      await client.query("SELECT set_config('app.placement_epoch',$1,true)", [
        placement.epoch,
      ]);
    }
    const result = await client.query(sql, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error(`${label} did not complete within 30 seconds`);
}
async function smoke() {
  const schemas = new Map();
  const systemIds = new Set();
  for (let index = 0; index < shardIds.length; index++) {
    const shardId = shardIds[index];
    const admin = pool(index, "postgres", "POSTGRES_PASSWORD", "read");
    const identityAdmin = pool(
      index,
      "postgres",
      "POSTGRES_PASSWORD",
      "postgres",
    );
    const standbyAdmin = pool(
      index,
      "postgres",
      "POSTGRES_PASSWORD",
      "read",
      true,
    );
    const writer = pool(
      index,
      "projection_app",
      "PROJECTION_DB_PASSWORD",
      "read",
    );
    const reader = pool(
      index,
      "read_query",
      "READ_QUERY_DB_PASSWORD",
      "read",
      true,
    );
    const tenant = `f0123456-0000-4000-8000-00000000000${index + 1}`;
    const device = `f1123456-0000-4000-8000-00000000000${index + 1}`;
    const otherTenant = `f0123456-0000-4000-8000-00000000000${((index + 1) % 4) + 1}`;
    try {
      const identity = await identityAdmin.query(
        "SELECT shard_id FROM public.greenguard_shard_identity",
      );
      assert.equal(identity.rows[0].shard_id, shardId);
      const incarnation = JSON.parse(
        readFileSync(
          resolve(root, ".local/sharding/incarnations.json"),
          "utf8",
        ),
      )[shardId];
      assert.match(
        incarnation,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
        `${shardId} must have a current local incarnation`,
      );
      const systemId = (
        await admin.query("SELECT system_identifier FROM pg_control_system()")
      ).rows[0].system_identifier;
      assert(
        !systemIds.has(systemId),
        "shards must have distinct physical PostgreSQL system identities",
      );
      systemIds.add(systemId);
      assert.equal(
        (
          await standbyAdmin.query(
            "SELECT system_identifier FROM pg_control_system()",
          )
        ).rows[0].system_identifier,
        systemId,
        "standby must belong to its own primary",
      );
      assert.equal(
        (await standbyAdmin.query("SELECT pg_is_in_recovery() AS standby"))
          .rows[0].standby,
        true,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM pg_stat_replication WHERE state='streaming'",
          )
        ).rows[0].n,
        1,
      );
      const databases = await admin.query(
        "SELECT datname FROM pg_database WHERE datname IN ('greenguard_control','greenguard_billing')",
      );
      assert.equal(
        databases.rowCount,
        0,
        "central databases must be excluded from operational bundles",
      );
      const roles = await admin.query(
        "SELECT rolname FROM pg_roles WHERE rolname IN ('projection_app','read_query') AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole)",
      );
      assert.equal(roles.rowCount, 0, "runtime roles must stay unprivileged");
      for (const [, database] of owners) {
        const databaseAdmin = pool(
          index,
          "postgres",
          "POSTGRES_PASSWORD",
          database,
        );
        try {
          const fingerprint = await databaseAdmin.query(
            "SELECT n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname IN ('public','read') AND c.relkind IN ('r','p','v') AND a.attnum>0 AND NOT a.attisdropped ORDER BY n.nspname,c.relname,a.attnum",
          );
          const signature = JSON.stringify(fingerprint.rows);
          if (!schemas.has(database)) schemas.set(database, signature);
          else
            assert.equal(
              signature,
              schemas.get(database),
              `${database} schema/RLS drifted across shards`,
            );
        } finally {
          await databaseAdmin.end();
        }
      }
      const bootstrap = await pool(
        index,
        "postgres",
        "POSTGRES_PASSWORD",
        "read",
      );
      try {
        await bootstrap.query("SET ROLE tenant_ownership_bootstrap");
        const snapshot = JSON.stringify([
          {
            tenantId: tenant,
            shardId,
            shardIncarnation: incarnation,
            placementEpoch: 1,
            state: "active",
          },
        ]);
        const seeded = await bootstrap.query(
          "SELECT greenguard_internal.seed_tenant_ownership($1::jsonb,$2,$3::uuid,1) AS imported",
          [snapshot, shardId, incarnation],
        );
        assert.equal(seeded.rows[0].imported, 1);
      } finally {
        await bootstrap.query("RESET ROLE").catch(() => {});
        await bootstrap.end();
      }
      const placement = { shardId, incarnation, epoch: "1" };
      await tenantQuery(
        admin,
        tenant,
        "DELETE FROM public.device_views WHERE tenant_id=$1 AND device_id=$2",
        [tenant, device],
        placement,
      );
      await tenantQuery(
        writer,
        tenant,
        "INSERT INTO public.device_views(tenant_id,device_id,site_id,serial_number,status,inventory_version) VALUES($1,$2,$3,$4,'active',1)",
        [tenant, device, "f2123456-0000-4000-8000-000000000001", shardId],
        placement,
      );
      await waitFor(
        async () =>
          (
            await tenantQuery(
              reader,
              tenant,
              "SELECT inventory_version FROM public.device_views WHERE tenant_id=$1 AND device_id=$2",
              [tenant, device],
            )
          ).rowCount === 1,
        `${shardId} replication`,
      );
      assert.equal(
        (
          await tenantQuery(
            reader,
            otherTenant,
            "SELECT tenant_id FROM public.device_views WHERE device_id=$1",
            [device],
          )
        ).rowCount,
        0,
        "RLS must reject a different tenant",
      );
      for (let foreign = 0; foreign < 4; foreign++) {
        if (foreign === index) continue;
        const foreignAdmin = pool(
          foreign,
          "postgres",
          "POSTGRES_PASSWORD",
          "read",
        );
        try {
          assert.equal(
            (
              await foreignAdmin.query(
                "SELECT 1 FROM public.device_views WHERE tenant_id=$1 AND device_id=$2",
                [tenant, device],
              )
            ).rowCount,
            0,
            "tenant data leaked into another physical bundle",
          );
        } finally {
          await foreignAdmin.end();
        }
      }
      await assert.rejects(
        standbyAdmin.query(
          "UPDATE public.device_views SET inventory_version=99 WHERE tenant_id=$1",
          [tenant],
        ),
        (error) => error.code === "25006",
      );
      await standbyAdmin.query("SELECT pg_wal_replay_pause()");
      await waitFor(
        async () =>
          (
            await standbyAdmin.query(
              "SELECT pg_get_wal_replay_pause_state() AS state",
            )
          ).rows[0].state === "paused",
        `${shardId} replay pause`,
      );
      await tenantQuery(
        writer,
        tenant,
        "UPDATE public.device_views SET inventory_version=2 WHERE tenant_id=$1 AND device_id=$2",
        [tenant, device],
        placement,
      );
      assert.equal(
        (
          await tenantQuery(
            reader,
            tenant,
            "SELECT inventory_version FROM public.device_views WHERE tenant_id=$1 AND device_id=$2",
            [tenant, device],
          )
        ).rows[0].inventory_version,
        "1",
        "paused replica should expose actual lag",
      );
      await standbyAdmin.query("SELECT pg_wal_replay_resume()");
      await waitFor(
        async () =>
          (
            await tenantQuery(
              reader,
              tenant,
              "SELECT inventory_version FROM public.device_views WHERE tenant_id=$1 AND device_id=$2",
              [tenant, device],
            )
          ).rows[0]?.inventory_version === "2",
        `${shardId} lag recovery`,
      );
      console.log(
        `${shardId}: schema parity, owner credentials, physical isolation, tenant RLS, read-only standby and replay pause/recovery passed`,
      );
    } finally {
      // Always unpause and delete only this test's unique row.
      await standbyAdmin.query("SELECT pg_wal_replay_resume()").catch(() => {});
      await tenantQuery(
        admin,
        tenant,
        "DELETE FROM public.device_views WHERE tenant_id=$1 AND device_id=$2",
        [tenant, device],
        {
          shardId,
          incarnation: JSON.parse(
            readFileSync(
              resolve(root, ".local/sharding/incarnations.json"),
              "utf8",
            ),
          )[shardId],
          epoch: "1",
        },
      ).catch(() => {});
      await Promise.all([
        admin.end(),
        identityAdmin.end(),
        standbyAdmin.end(),
        writer.end(),
        reader.end(),
      ]);
    }
  }
}
async function verifyFences() {
  for (let index = 0; index < shardIds.length; index++) {
    for (const [owner, database, prefix] of owners) {
      const migrationOwner = pool(
        index,
        `${owner}_migrator`,
        `${prefix}_MIGRATOR_PASSWORD`,
        database,
      );
      try {
        await migrationOwner.query(
          "SELECT greenguard_internal.assert_tenant_fences_installed()",
        );
      } finally {
        await migrationOwner.end();
      }
    }
    console.log(
      `${shardIds[index]}: all nine owner fence installation audits passed`,
    );
  }
}

const mode = process.argv[2];
if (mode === "up") {
  run("docker", [
    ...compose,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "180",
    ...shardIds.map((id) => `postgres-${id}`),
  ]);
  for (const id of shardIds) {
    run("docker", [
      ...compose,
      "exec",
      "-T",
      `postgres-${id}`,
      "psql",
      "-q",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-f",
      "/docker-entrypoint-initdb.d/001-shard.sql",
    ]);
    run("docker", [
      ...compose,
      "exec",
      "-T",
      `postgres-${id}`,
      "psql",
      "-q",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      "SELECT pg_reload_conf()",
    ]);
  }
  run("docker", [...compose, "up", "-d", "--wait", "--wait-timeout", "180"]);
} else if (mode === "down") run("docker", [...compose, "down"]);
else if (mode === "migrate") {
  for (let index = 0; index < 4; index++) {
    console.log(
      `Applying all nine operational owner migrations to ${shardIds[index]}`,
    );
    for (const [owner, database, prefix, service, toolchain] of owners) {
      const env = {
        ...environment,
        [`${prefix}_MIGRATION_URL`]: url(
          index,
          `${owner}_migrator`,
          `${prefix}_MIGRATOR_PASSWORD`,
          database,
        ),
      };
      if (toolchain === "go")
        run(
          "go",
          ["run", "./cmd/migrate"],
          resolve(root, "services", service),
          env,
        );
      else if (toolchain === "python")
        run(
          resolve(root, ".local/risk-venv/bin/python"),
          ["-m", "risk_engine.migrate"],
          resolve(root, "services", service),
          env,
        );
      else
        run("npm", ["run", "migrate", "-w", `services/${service}`], root, env);
    }
  }
  await verifyFences();
} else if (mode === "smoke") await smoke();
else if (mode === "verify-fences") await verifyFences();
else if (mode === "registry") {
  const incarnations = {};
  for (let index = 0; index < shardIds.length; index++) {
    const admin = pool(index, "postgres", "POSTGRES_PASSWORD", "postgres");
    try {
      const systemId = (
        await admin.query("SELECT system_identifier FROM pg_control_system()")
      ).rows[0].system_identifier;
      const hex = createHash("sha256")
        .update(`${project}/${shardIds[index]}/${systemId}`)
        .digest("hex");
      incarnations[shardIds[index]] =
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    } finally {
      await admin.end();
    }
  }
  const registry = Object.fromEntries(
    shardIds.map((id, index) => [
      id,
      {
        primaryHost: "127.0.0.1",
        primaryPort: 57431 + index,
        replicaHost: "127.0.0.1",
        replicaPort: 58431 + index,
        owners: Object.fromEntries(
          owners.map(([owner, database, prefix]) => [
            owner,
            {
              migrationUrl: url(
                index,
                `${owner}_migrator`,
                `${prefix}_MIGRATOR_PASSWORD`,
                database,
              ),
            },
          ]),
        ),
        readUrl: url(index, "read_query", "READ_QUERY_DB_PASSWORD", "read"),
        readReplicaUrls: [
          url(index, "read_query", "READ_QUERY_DB_PASSWORD", "read", true),
        ],
      },
    ]),
  );
  const directory = resolve(root, ".local/sharding");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(directory, "incarnations.json"),
    JSON.stringify(incarnations, null, 2),
    { mode: 0o600 },
  );
  chmodSync(resolve(directory, "incarnations.json"), 0o600);
  writeFileSync(
    resolve(directory, "registry.json"),
    JSON.stringify(registry, null, 2),
    { mode: 0o600 },
  );
  chmodSync(resolve(directory, "registry.json"), 0o600);
  // Each runtime service receives only its own owner-role credentials.
  for (const [owner, database, prefix, service] of owners) {
    const config = {
      formatVersion: 1,
      service,
      database: `greenguard_${database}`,
      shards: Object.fromEntries(
        shardIds.map((id, index) => [
          id,
          {
            incarnation: incarnations[id],
            primaryUrl: url(
              index,
              `${owner}_app`,
              `${prefix}_DB_PASSWORD`,
              database,
            ),
            replicaUrls: [],
          },
        ]),
      ),
    };
    const path = resolve(directory, `${service}.json`);
    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const readConfig = {
    formatVersion: 1,
    service: "read-api",
    database: "greenguard_read",
    shards: Object.fromEntries(
      shardIds.map((id, index) => [
        id,
        {
          incarnation: incarnations[id],
          primaryUrl: url(
            index,
            "read_query",
            "READ_QUERY_DB_PASSWORD",
            "read",
          ),
          replicaUrls: [
            url(index, "read_query", "READ_QUERY_DB_PASSWORD", "read", true),
          ],
        },
      ]),
    ),
  };
  const readPath = resolve(directory, "read-api.json");
  writeFileSync(readPath, JSON.stringify(readConfig, null, 2), { mode: 0o600 });
  chmodSync(readPath, 0o600);
  console.log(
    "Private endpoint registry written to .local/sharding/registry.json (credentials omitted from output)",
  );
} else
  throw new Error(
    "Usage: node scripts/shards-local.mjs up|migrate|verify-fences|smoke|registry|down",
  );
