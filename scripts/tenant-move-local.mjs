#!/usr/bin/env node
// Isolated, single-owner tenant move acceptance. Uses fresh PostgreSQL scratch
// resources and never reads .env or connects to a shared database.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(resolve(tmpdir(), "gg-tenant-move-"));
const suffix = randomBytes(6).toString("hex");
const container = `gg-tenant-move-${suffix}`;
const initSql = readFileSync(resolve(root, "infra/compose/init-databases.sql"), "utf8");
const secretKeys = new Set(["POSTGRES_PASSWORD", ...Array.from(initSql.matchAll(/\\getenv\s+\w+\s+(\w+)/g), (m) => m[1])]);
const environment = { ...process.env };
for (const key of secretKeys) environment[key] = randomBytes(24).toString("hex");
const secretPath = resolve(scratch, "compose.env");
writeFileSync(secretPath, [...secretKeys].map((key) => `${key}=${environment[key]}`).join("\n") + "\n", { mode: 0o600 });
const created = [];
const redact = (text) => [...secretKeys].reduce((out, key) => out.replaceAll(environment[key], "[redacted]"), text);
function run(command, args, env = environment) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(redact(result.stdout));
  if (result.stderr) process.stderr.write(redact(result.stderr));
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? "spawn"})`);
  return result.stdout.trim();
}
function docker(args) {
  const result = spawnSync("docker", args, { cwd: root, env: environment, encoding: "utf8" });
  if (result.status !== 0) throw new Error(redact(result.stderr));
  return result.stdout.trim();
}
const conn = (role, passwordKey, database, port) => {
  const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  url.username = role;
  url.password = environment[passwordKey];
  return url.toString();
};
const waitPg = async (url) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 500 });
    try { await client.connect(); await client.query("SELECT 1"); return; }
    catch { await new Promise((accept) => setTimeout(accept, 200)); }
    finally { await client.end().catch(() => {}); }
  }
  throw new Error("scratch PostgreSQL did not become ready");
};
const connectScoped = async (pool, tenantId, identity) => {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
  if (identity) {
    await client.query("SELECT set_config('app.shard_id',$1,true)", [identity.shardId]);
    await client.query("SELECT set_config('app.shard_incarnation',$1,true)", [identity.incarnation]);
    await client.query("SELECT set_config('app.placement_epoch',$1,true)", [identity.epoch]);
  }
  return client;
};
try {
  docker(["run", "-d", "--name", container, "--env-file", secretPath,
    "-p", "127.0.0.1::5432", "-v", `${resolve(root, "infra/compose/init-databases.sql")}:/docker-entrypoint-initdb.d/001-init.sql:ro`,
    "postgres:16"]);
  created.push(container);
  const port = docker(["port", container, "5432/tcp"]).split(":").at(-1);
  environment.POSTGRES_ADMIN_URL = conn("postgres", "POSTGRES_PASSWORD", "postgres", port);
  environment.CONTROL_MIGRATION_URL = conn("control_migrator", "CONTROL_MIGRATOR_PASSWORD", "greenguard_control", port);
  environment.CONTROL_DATABASE_URL = environment.CONTROL_DIRECT_URL = conn("control_app", "CONTROL_DB_PASSWORD", "greenguard_control", port);
  environment.RISK_MIGRATION_URL = conn("risk_migrator", "RISK_MIGRATOR_PASSWORD", "greenguard_risk", port);
  environment.RISK_SOURCE_URL = conn("risk_migrator", "RISK_MIGRATOR_PASSWORD", "greenguard_risk", port);
  await waitPg(environment.CONTROL_MIGRATION_URL);
  run("npm", ["run", "migrate", "-w", "@greenguard/tenant-control-plane"]);
  run("node", ["--test", "services/tenant-control-plane/dist/domain/placement.test.js"]);
  run(".local/risk-venv/bin/python", ["-m", "risk_engine.migrate"], { ...environment, PYTHONPATH: resolve(root, "services/risk-engine") });
  console.log("Scratch control and risk schemas migrated.");
  const admin = new pg.Client({ connectionString: environment.POSTGRES_ADMIN_URL });
  await admin.connect();
  await admin.query("CREATE DATABASE greenguard_risk_s2 TEMPLATE greenguard_risk");
  await admin.end();
  const controlAdmin = new pg.Client({ connectionString: conn("postgres", "POSTGRES_PASSWORD", "greenguard_control", port) });
  await controlAdmin.connect();
  await controlAdmin.query("UPDATE shard_registry SET state='active' WHERE shard_id='s2'");
  await controlAdmin.end();
  environment.RISK_TARGET_URL = conn("risk_migrator", "RISK_MIGRATOR_PASSWORD", "greenguard_risk_s2", port);

  const { createDb } = await import("../services/tenant-control-plane/dist/db/client.js");
  const { createOrganization } = await import("../services/tenant-control-plane/dist/domain/store.js");
  const placement = await import("../services/tenant-control-plane/dist/domain/placement.js");
  const leases = await import("../services/tenant-control-plane/dist/domain/read-leases.js");
  const { activateRiskMoveTarget, copyTenantSnapshot, fenceRiskMoveSource, prepareRiskMoveTarget, recordRiskMoveCopy } = await import("../services/tenant-control-plane/dist/tenant-move/pg-owner.js");
  const control = createDb(environment.CONTROL_DATABASE_URL, 4);
  const actor = { issuer: "https://tenant-move.local", subject: `move-${randomUUID()}` };
  const createdOrg = await createOrganization(control, actor, { name: "isolated move acceptance" }, {
    idempotencyKey: randomUUID(), correlationId: randomUUID(),
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  });
  const tenantId = createdOrg.body.tenantId;
  assert.equal(createdOrg.status, 201);
  const route = await placement.resolveTenant(control, tenantId);
  assert.equal(route.shardId, "s1");
  const [registry] = await control.$queryRaw`SELECT shard_id,shard_incarnation::text AS incarnation,state FROM shard_registry WHERE shard_id IN ('s1','s2') ORDER BY shard_id`;
  const targetRegistryRows = await control.$queryRaw`SELECT shard_id,shard_incarnation::text AS incarnation,state FROM shard_registry WHERE shard_id='s2'`;
  const sourceRows = await control.$queryRaw`SELECT shard_id,shard_incarnation::text AS incarnation,state FROM shard_registry WHERE shard_id='s1'`;
  const sourceIdentity = { shardId: sourceRows[0].shard_id, incarnation: sourceRows[0].incarnation, epoch: "1" };
  const targetIdentity = { shardId: targetRegistryRows[0].shard_id, incarnation: targetRegistryRows[0].incarnation, epoch: "2" };
  assert.equal(registry.shard_id, "s1");
  assert.equal(targetRegistryRows[0].state, "active");
  console.log(`Prepared tenant ${tenantId} on ${route.shardId}; target ${targetIdentity.shardId} is registered.`);

  const source = new pg.Pool({ connectionString: environment.RISK_SOURCE_URL, max: 4 });
  const target = new pg.Pool({ connectionString: environment.RISK_TARGET_URL, max: 4 });
  const adminSource = new pg.Pool({ connectionString: environment.RISK_SOURCE_URL, max: 2 });
  const adminTarget = new pg.Pool({ connectionString: environment.RISK_TARGET_URL, max: 2 });
  const deviceId = randomUUID();
  const otherTenant = randomUUID();
  try {
    await adminSource.query(`INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,'s1',$2,1,'active'),($3,'s1',$2,1,'active')`, [tenantId, sourceIdentity.incarnation, otherTenant]);
    const write = await connectScoped(source, tenantId, sourceIdentity);
    try {
      await write.query(`INSERT INTO device_bindings(tenant_id,device_id,status,inventory_version,binding_version,source_event_id) VALUES($1,$2,'active',1,1,$3)`, [tenantId, deviceId, randomUUID()]);
      await write.query("COMMIT");
    } finally { await write.query("ROLLBACK").catch(() => {}); write.release(); }
    const unrelatedDevice = randomUUID();
    const otherWrite = await connectScoped(source, otherTenant, sourceIdentity);
    try {
      await otherWrite.query(`INSERT INTO device_bindings(tenant_id,device_id,status,inventory_version,binding_version,source_event_id) VALUES($1,$2,'active',1,1,$3)`, [otherTenant, unrelatedDevice, randomUUID()]);
      await otherWrite.query("COMMIT");
    } finally { await otherWrite.query("ROLLBACK").catch(() => {}); otherWrite.release(); }

    const operationId = randomUUID();
    const lease = await leases.acquireReadLease(control, tenantId);
    const preparedReceipt = await prepareRiskMoveTarget(adminTarget, tenantId, operationId, sourceIdentity, targetIdentity);
    assert.equal(preparedReceipt.state, "prepared");
    await assert.rejects(prepareRiskMoveTarget(adminTarget, tenantId, operationId, sourceIdentity, { ...targetIdentity, shardId: "s3" }), /operation identity conflict/);
    await assert.rejects(adminTarget.query("SELECT greenguard_internal.activate_tenant_move_target($1::uuid,$2::uuid)", [tenantId, operationId]), /requires a verified copy receipt/);
    await placement.beginPlacementMove(control, tenantId, "1", "s2", operationId);
    console.log(`Tenant ${tenantId} is quiescing for ${operationId}.`);

    // Hold the owner's shared placement admission lock to prove the exclusive
    // source fence waits for an accepted transaction.
    const accepted = await connectScoped(source, tenantId, sourceIdentity);
    try {
      await accepted.query("SELECT greenguard_internal.admit_tenant_placement($1,$2,$3,$4)", [tenantId, sourceIdentity.shardId, sourceIdentity.incarnation, sourceIdentity.epoch]);
      const fenceAttempt = await adminSource.connect();
      try {
        await fenceAttempt.query("BEGIN");
        await fenceAttempt.query("SET LOCAL lock_timeout='100ms'");
        await assert.rejects(fenceAttempt.query(`UPDATE greenguard_internal.tenant_ownership SET state='fenced' WHERE tenant_id=$1`, [tenantId]), /lock timeout|canceling statement/);
      } finally { await fenceAttempt.query("ROLLBACK").catch(() => {}); fenceAttempt.release(); }
      await accepted.query("COMMIT");
    } finally { await accepted.query("ROLLBACK").catch(() => {}); accepted.release(); }
    const sourceFencedReceipt = await fenceRiskMoveSource(adminSource, tenantId, operationId, sourceIdentity, targetIdentity);

    const copy = await copyTenantSnapshot(source, target, tenantId, operationId, sourceIdentity, targetIdentity);
    assert.equal(copy.sourceSha256, copy.targetSha256);
    assert.ok(BigInt(copy.rowCount) >= 1n);
    const copyProof = await recordRiskMoveCopy(adminTarget, copy);
    for (const [key, proof] of [["source_fenced", sourceFencedReceipt], ["target_prepared", preparedReceipt], ["copy_verified", copyProof]]) await placement.recordPlacementMoveReceipt(control, tenantId, operationId, key, proof);
    assert.equal((await adminTarget.query("SELECT state FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1", [tenantId])).rows[0].state, "prepared");
    await assert.rejects(activateRiskMoveTarget(adminTarget, tenantId, operationId, sourceIdentity, targetIdentity, await placement.resolveTenant(control, tenantId)), /placement is not switched/);
    assert.equal((await adminTarget.query("SELECT state FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1", [tenantId])).rows[0].state, "prepared");
    await assert.rejects(placement.compareAndSetPlacement(control, tenantId, "1", "s2", operationId), /read leases must drain/);
    await leases.releaseReadLease(control, tenantId, lease.leaseId);
    await placement.compareAndSetPlacement(control, tenantId, "1", "s2", operationId);
    const activationProof = await activateRiskMoveTarget(adminTarget, tenantId, operationId, sourceIdentity, targetIdentity, await placement.resolveTenant(control, tenantId));
    const activated = await adminTarget.query(`SELECT shard_id,shard_incarnation::text AS incarnation,placement_epoch::text AS epoch,state FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1`, [tenantId]);
    assert.deepEqual(activated.rows[0], { shard_id: "s2", incarnation: targetIdentity.incarnation, epoch: "2", state: "active" });
    await placement.recordPlacementMoveReceipt(control, tenantId, operationId, "target_activated", activationProof);
    await placement.finishPlacementMove(control, tenantId, operationId, "completed");
    const newRoute = await placement.resolveTenant(control, tenantId);
    assert.equal(newRoute.shardId, "s2");
    assert.equal(newRoute.placementEpoch, "2");
    const movedRead = await connectScoped(target, tenantId, targetIdentity);
    try {
      const moved = await movedRead.query("SELECT device_id::text FROM device_bindings WHERE tenant_id=$1", [tenantId]);
      assert.deepEqual(moved.rows, [{ device_id: deviceId }]);
      await movedRead.query("COMMIT");
    } finally { await movedRead.query("ROLLBACK").catch(() => {}); movedRead.release(); }
    const stale = await connectScoped(source, tenantId, sourceIdentity);
    try {
      await assert.rejects(stale.query("UPDATE device_bindings SET status='inactive',inventory_version=2,binding_version=2 WHERE tenant_id=$1", [tenantId]), /tenant placement/i);
    } finally {
      await stale.query("ROLLBACK").catch(() => {});
      stale.release();
    }
    const unrelatedRead = await connectScoped(source, otherTenant, sourceIdentity);
    try {
      assert.equal((await unrelatedRead.query("SELECT device_id::text FROM device_bindings WHERE tenant_id=$1", [otherTenant])).rows[0].device_id, unrelatedDevice);
      await unrelatedRead.query("COMMIT");
    } finally { await unrelatedRead.query("ROLLBACK").catch(() => {}); unrelatedRead.release(); }
    console.log(`Local tenant move passed: operation=${operationId} tables=${copy.tableCount} rows=${copy.rowCount} sha256=${copy.sourceSha256}; lease drained, source writer fenced, placement epoch 1→2, unrelated tenant preserved.`);
  } finally {
    await Promise.all([source.end(), target.end(), adminSource.end(), adminTarget.end()]);
  }
  await control.$disconnect();
} finally {
  for (const name of created.reverse()) docker(["rm", "-f", name]);
  rmSync(scratch, { recursive: true, force: true });
}
