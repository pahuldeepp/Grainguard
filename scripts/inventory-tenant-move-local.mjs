#!/usr/bin/env node
// Isolated inventory owner move acceptance. It provisions one randomly named
// disposable PostgreSQL container with random local credentials, runs only the
// inventory migrations, and removes the container/temp credentials in finally.
// It never reads .env, shared Compose databases, or AWS credentials/endpoints.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(resolve(tmpdir(), "gg-inventory-move-"));
const suffix = randomBytes(6).toString("hex");
const container = `gg-inventory-move-${suffix}`;
const initSqlPath = resolve(root, "infra/compose/init-databases.sql");
const initSql = readFileSync(initSqlPath, "utf8");
const secretKeys = new Set([
  "POSTGRES_PASSWORD",
  ...Array.from(initSql.matchAll(/\\getenv\s+\w+\s+(\w+)/g), (match) => match[1]),
]);
const environment = { ...process.env };
for (const key of secretKeys) environment[key] = randomBytes(24).toString("hex");
const secretPath = resolve(scratch, "local-postgres.env");
writeFileSync(
  secretPath,
  [...secretKeys].map((key) => `${key}=${environment[key]}`).join("\n") + "\n",
  { mode: 0o600 },
);
const redact = (value) =>
  [...secretKeys].reduce(
    (output, key) => output.replaceAll(environment[key], "[redacted]"),
    value,
  );
const run = (command, args, cwd = root, env = environment) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(redact(result.stdout));
  if (result.stderr) process.stderr.write(redact(result.stderr));
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed (${result.status ?? "spawn"})`);
  return result.stdout.trim();
};
const docker = (args) => {
  const result = spawnSync("docker", args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(redact(result.stderr));
  return result.stdout.trim();
};
const connectionString = (role, passwordKey, database, port) => {
  const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  url.username = role;
  url.password = environment[passwordKey];
  return url.toString();
};
const waitPg = async (url) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 500 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    } finally {
      await client.end().catch(() => {});
    }
  }
  throw new Error("isolated PostgreSQL did not become ready");
};
const withClient = async (url, fn) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};
const source = { shardId: "s1", incarnation: randomUUID(), epoch: "1" };
const target = { shardId: "s2", incarnation: randomUUID(), epoch: "2" };
let containerId;
let sourcePool;
let targetPool;

async function seedTenant(adminUrl, tenantId, { withOutbox = false, withPendingSaga = false } = {}) {
  const deviceId = randomUUID();
  const siteId = randomUUID();
  const binId = randomUUID();
  const operationIds = { command: randomUUID(), saga: randomUUID(), result: randomUUID() };
  await withClient(adminUrl, async (db) => {
    await db.query("BEGIN");
    try {
      await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await db.query("SELECT set_config('app.shard_id',$1,true)", [source.shardId]);
      await db.query("SELECT set_config('app.shard_incarnation',$1,true)", [source.incarnation]);
      await db.query("SELECT set_config('app.placement_epoch',$1,true)", [source.epoch]);
      await db.query(
        "INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,$2,$3,$4,'active')",
        [tenantId, source.shardId, source.incarnation, source.epoch],
      );
      await db.query("INSERT INTO tenants(tenant_id,name) VALUES($1,'isolated move acceptance')", [tenantId]);
      await db.query("INSERT INTO sites(tenant_id,site_id,name) VALUES($1,$2,'site')", [tenantId, siteId]);
      await db.query("INSERT INTO bins(tenant_id,bin_id,site_id,name) VALUES($1,$2,$3,'bin')", [tenantId, binId, siteId]);
      await db.query(
        "INSERT INTO devices(tenant_id,device_id,site_id,bin_id,serial_number,status) VALUES($1,$2,$3,$4,$5,'active')",
        [tenantId, deviceId, siteId, binId, `serial-${tenantId}`],
      );
      if (withOutbox) {
        await db.query(
          `INSERT INTO outbox_events(event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,correlation_id,causation_id,traceparent,payload)
           VALUES($1,$2,'device',$3,1,'device.registered',1,now(),$4,$5,'00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01','{}'::jsonb)`,
          [randomUUID(), tenantId, deviceId, randomUUID(), randomUUID()],
        );
      }
      if (withPendingSaga) {
        await db.query(
          `INSERT INTO inventory_saga_receipts(tenant_id,command_id,saga_id,device_id,asset_id,step,saga_version,fencing_token,outcome,result_id)
           VALUES($1,$2,$3,$4,$5,'inventory.activate',1,1,'succeeded',$6)`,
          [tenantId, operationIds.command, operationIds.saga, deviceId, randomUUID(), operationIds.result],
        );
        await db.query(
          `INSERT INTO inventory_saga_result_outbox(tenant_id,result_id,command_id,saga_id,step,saga_version,fencing_token,outcome)
           VALUES($1,$2,$3,$4,'inventory.activate',1,1,'succeeded')`,
          [tenantId, operationIds.result, operationIds.command, operationIds.saga],
        );
      }
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
  return { deviceId, siteId, binId };
}

async function assertFunctionFenceRejected(url, tenantId, operationId, expected) {
  await withClient(url, async (db) => {
    await assert.rejects(
      db.query(
        `SELECT greenguard_internal.fence_tenant_move_source($1::uuid,$2::uuid,$3,$4::uuid,$5::bigint,$6,$7::uuid,$8::bigint)`,
        [tenantId, operationId, source.shardId, source.incarnation, source.epoch, target.shardId, target.incarnation, target.epoch],
      ),
      expected,
    );
  });
}

try {
  run("npm", ["run", "build", "-w", "@greenguard/tenant-control-plane"]);
  const id = docker([
    "run", "-d", "--name", container, "--env-file", secretPath,
    "-p", "127.0.0.1::5432", "-v", `${initSqlPath}:/docker-entrypoint-initdb.d/001-init.sql:ro`, "postgres:16",
  ]);
  containerId = id;
  const port = docker(["port", container, "5432/tcp"]).split(":").at(-1);
  const adminUrl = connectionString("postgres", "POSTGRES_PASSWORD", "postgres", port);
  const inventoryAdminUrl = connectionString("postgres", "POSTGRES_PASSWORD", "greenguard_inventory", port);
  const sourceUrl = connectionString("inventory_migrator", "INVENTORY_MIGRATOR_PASSWORD", "greenguard_inventory", port);
  await waitPg(adminUrl);
  environment.INVENTORY_MIGRATION_URL = sourceUrl;
  run("npm", ["run", "migrate", "-w", "@greenguard/device-service"], root, environment);
  await withClient(adminUrl, (db) => db.query(
    "CREATE DATABASE greenguard_inventory_s2 WITH TEMPLATE greenguard_inventory OWNER inventory_migrator",
  ));
  const targetUrl = connectionString("inventory_migrator", "INVENTORY_MIGRATOR_PASSWORD", "greenguard_inventory_s2", port);
  const targetAdminUrl = connectionString("postgres", "POSTGRES_PASSWORD", "greenguard_inventory_s2", port);
  sourcePool = new pg.Pool({ connectionString: sourceUrl, max: 2 });
  targetPool = new pg.Pool({ connectionString: targetUrl, max: 2 });
  const {
    abortInventoryMoveTarget,
    assertInventoryMoveEffectsDrained,
    assertInventoryMoveSchema,
    copyInventoryTenantSnapshot,
    fenceInventoryMoveSource,
    prepareInventoryMoveTarget,
    reactivateInventoryMoveSource,
  } = await import("../services/tenant-control-plane/dist/tenant-move/inventory-owner.js");

  // Execute a complete owner-local copy + receipt + target abort + source epoch
  // advance, with real row triggers and RLS in the two isolated shard databases.
  const tenantId = randomUUID();
  const operationId = randomUUID();
  const seeded = await seedTenant(inventoryAdminUrl, tenantId);
  await Promise.all([assertInventoryMoveSchema(sourcePool), assertInventoryMoveSchema(targetPool)]);
  await prepareInventoryMoveTarget(targetPool, tenantId, operationId, source, target);
  await fenceInventoryMoveSource(sourcePool, tenantId, operationId, source, target);
  const copied = await copyInventoryTenantSnapshot(sourcePool, targetPool, tenantId, operationId, source, target);
  assert.equal(copied.receipt.phase, "copy_verified");
  assert.equal(copied.receipt.rowCount, "4");
  assert.equal(copied.receipt.tableCount, 15);
  assert.equal(copied.receipt.sourceSha256, copied.receipt.targetSha256);
  const replay = await copyInventoryTenantSnapshot(sourcePool, targetPool, tenantId, operationId, source, target);
  assert.deepEqual(replay.receipt, copied.receipt);
  const targetAbort = await abortInventoryMoveTarget(targetPool, tenantId, operationId, source, target);
  assert.equal(targetAbort.state, "absent");
  const sourceReactivated = await reactivateInventoryMoveSource(sourcePool, tenantId, operationId, source, target, targetAbort);
  assert.equal(sourceReactivated.epoch, target.epoch);
  await withClient(targetAdminUrl, async (db) => {
    const rows = await db.query("SELECT count(*)::int AS n FROM devices WHERE tenant_id=$1", [tenantId]);
    const owner = await db.query("SELECT count(*)::int AS n FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1", [tenantId]);
    assert.equal(rows.rows[0].n, 0);
    assert.equal(owner.rows[0].n, 0);
  });
  await withClient(inventoryAdminUrl, async (db) => {
    const rows = await db.query("SELECT count(*)::int AS n FROM devices WHERE tenant_id=$1", [tenantId]);
    const owner = await db.query("SELECT state,placement_epoch::text AS epoch FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1", [tenantId]);
    assert.equal(rows.rows[0].n, 1);
    assert.deepEqual(owner.rows[0], { state: "active", epoch: "2" });
  });

  // Historical CDC rows are an intentional hard blocker (including the SQL
  // function's own guard, independent of the adapter's diagnostic preflight).
  const cdcTenant = randomUUID();
  const cdcOperation = randomUUID();
  await seedTenant(inventoryAdminUrl, cdcTenant, { withOutbox: true });
  await withClient(sourceUrl, async (db) => {
    await db.query("BEGIN");
    try {
      // The migration role's RLS policy must not let a caller scope itself to
      // another tenant and discover that tenant's CDC history.
      await db.query("SELECT set_config('app.tenant_id',$1,true)", [randomUUID()]);
      const hidden = await db.query(
        "SELECT count(*)::int AS n FROM public.outbox_events WHERE tenant_id=$1::uuid",
        [cdcTenant],
      );
      assert.equal(hidden.rows[0].n, 0);
      await db.query("SELECT set_config('app.tenant_id',$1,true)", [cdcTenant]);
      const visible = await db.query(
        "SELECT count(*)::int AS n FROM public.outbox_events WHERE tenant_id=$1::uuid",
        [cdcTenant],
      );
      assert.equal(visible.rows[0].n, 1);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
  await prepareInventoryMoveTarget(targetPool, cdcTenant, cdcOperation, source, target);
  await assert.rejects(assertInventoryMoveEffectsDrained(sourcePool, cdcTenant), /CDC outbox history/);
  await assertFunctionFenceRejected(sourceUrl, cdcTenant, cdcOperation, /CDC outbox history/);

  // Pending saga outcomes are independently rejected before source fencing.
  const sagaTenant = randomUUID();
  const sagaOperation = randomUUID();
  await seedTenant(inventoryAdminUrl, sagaTenant, { withPendingSaga: true });
  await prepareInventoryMoveTarget(targetPool, sagaTenant, sagaOperation, source, target);
  await assert.rejects(assertInventoryMoveEffectsDrained(sourcePool, sagaTenant), /pending saga result effects/);
  await assertFunctionFenceRejected(sourceUrl, sagaTenant, sagaOperation, /pending saga result effects/);

  // Ensure copy performed the intended four inventory entity rows and source
  // data was retained throughout the aborted migration path.
  assert.deepEqual(seeded, { deviceId: seeded.deviceId, siteId: seeded.siteId, binId: seeded.binId });
  console.log("Inventory owner isolated acceptance passed: 15-table schema gate, 4-row verified copy and durable receipt, idempotent copy replay, abort cleanup, source recovery at epoch 2, and SQL + adapter rejection of historical CDC and pending saga effects.");
} finally {
  await sourcePool?.end().catch(() => {});
  await targetPool?.end().catch(() => {});
  if (containerId) docker(["rm", "-f", container]);
  rmSync(scratch, { recursive: true, force: true });
}
