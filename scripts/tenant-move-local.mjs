#!/usr/bin/env node
// Isolated Risk-owner move acceptance. It verifies owner-local CDC fencing, atomic
// copy receipt, target abort, and source reactivation, while the global control-plane
// move still fails closed because the full owner adapter set is not integrated.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(resolve(tmpdir(), "gg-tenant-move-"));
const suffix = randomBytes(6).toString("hex");
const container = `gg-tenant-move-${suffix}`;
const initSql = readFileSync(
  resolve(root, "infra/compose/init-databases.sql"),
  "utf8",
);
const secretKeys = new Set([
  "POSTGRES_PASSWORD",
  ...Array.from(initSql.matchAll(/\\getenv\s+\w+\s+(\w+)/g), (m) => m[1]),
]);
const environment = { ...process.env };
for (const key of secretKeys)
  environment[key] = randomBytes(24).toString("hex");
const secretPath = resolve(scratch, "compose.env");
writeFileSync(
  secretPath,
  [...secretKeys].map((key) => `${key}=${environment[key]}`).join("\n") + "\n",
  { mode: 0o600 },
);
const created = [];
const redact = (text) =>
  [...secretKeys].reduce(
    (out, key) => out.replaceAll(environment[key], "[redacted]"),
    text,
  );
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
    throw new Error(`${command} failed (${result.status ?? "spawn"})`);
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
const conn = (role, passwordKey, database, port) => {
  const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  url.username = role;
  url.password = environment[passwordKey];
  return url.toString();
};
const waitPg = async (url) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const client = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: 500,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return;
    } catch {
      await new Promise((accept) => setTimeout(accept, 200));
    } finally {
      await client.end().catch(() => {});
    }
  }
  throw new Error("scratch PostgreSQL did not become ready");
};
const connectScoped = async (pool, tenantId, identity) => {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
  if (identity) {
    await client.query("SELECT set_config('app.shard_id',$1,true)", [
      identity.shardId,
    ]);
    await client.query("SELECT set_config('app.shard_incarnation',$1,true)", [
      identity.incarnation,
    ]);
    await client.query("SELECT set_config('app.placement_epoch',$1,true)", [
      identity.epoch,
    ]);
  }
  return client;
};
try {
  docker([
    "run",
    "-d",
    "--name",
    container,
    "--env-file",
    secretPath,
    "-p",
    "127.0.0.1::5432",
    "-v",
    `${resolve(root, "infra/compose/init-databases.sql")}:/docker-entrypoint-initdb.d/001-init.sql:ro`,
    "postgres:16",
  ]);
  created.push(container);
  const port = docker(["port", container, "5432/tcp"]).split(":").at(-1);
  environment.POSTGRES_ADMIN_URL = conn(
    "postgres",
    "POSTGRES_PASSWORD",
    "postgres",
    port,
  );
  environment.CONTROL_MIGRATION_URL = conn(
    "control_migrator",
    "CONTROL_MIGRATOR_PASSWORD",
    "greenguard_control",
    port,
  );
  environment.CONTROL_DATABASE_URL = environment.CONTROL_DIRECT_URL = conn(
    "control_app",
    "CONTROL_DB_PASSWORD",
    "greenguard_control",
    port,
  );
  environment.RISK_MIGRATION_URL = conn(
    "risk_migrator",
    "RISK_MIGRATOR_PASSWORD",
    "greenguard_risk",
    port,
  );
  environment.RISK_SOURCE_URL = conn(
    "risk_migrator",
    "RISK_MIGRATOR_PASSWORD",
    "greenguard_risk",
    port,
  );
  await waitPg(environment.CONTROL_MIGRATION_URL);
  run("npm", ["run", "migrate", "-w", "@greenguard/tenant-control-plane"]);
  run("node", [
    "--test",
    "services/tenant-control-plane/dist/domain/placement.test.js",
  ]);
  run(".local/risk-venv/bin/python", ["-m", "risk_engine.migrate"], {
    ...environment,
    PYTHONPATH: resolve(root, "services/risk-engine"),
  });
  console.log("Scratch control and risk schemas migrated.");
  const admin = new pg.Client({
    connectionString: environment.POSTGRES_ADMIN_URL,
  });
  await admin.connect();
  await admin.query(
    "CREATE DATABASE greenguard_risk_s2 TEMPLATE greenguard_risk",
  );
  await admin.end();
  const controlAdmin = new pg.Client({
    connectionString: conn(
      "postgres",
      "POSTGRES_PASSWORD",
      "greenguard_control",
      port,
    ),
  });
  await controlAdmin.connect();
  await controlAdmin.query(
    "UPDATE shard_registry SET state='active' WHERE shard_id='s2'",
  );
  await controlAdmin.end();
  environment.RISK_TARGET_URL = conn(
    "risk_migrator",
    "RISK_MIGRATOR_PASSWORD",
    "greenguard_risk_s2",
    port,
  );

  const { createDb } =
    await import("../services/tenant-control-plane/dist/db/client.js");
  const { createOrganization } =
    await import("../services/tenant-control-plane/dist/domain/store.js");
  const placement =
    await import("../services/tenant-control-plane/dist/domain/placement.js");
  const leases =
    await import("../services/tenant-control-plane/dist/domain/read-leases.js");
  const riskOwnerModule = pathToFileURL(
    process.env.GG_RISK_OWNER_MODULE ?? resolve(root, "services/tenant-control-plane/dist/tenant-move/risk-owner.js"),
  ).href;
  const {
    abortRiskMoveTarget,
    activateRiskMoveTarget,
    copyRiskTenantSnapshot,
    fenceRiskMoveSource,
    prepareRiskMoveTarget,
    reactivateRiskMoveSource,
    assertRiskMoveEffectsDrained,
  } = await import(riskOwnerModule);
  const control = createDb(environment.CONTROL_DATABASE_URL, 4);
  const actor = {
    issuer: "https://tenant-move.local",
    subject: `move-${randomUUID()}`,
  };
  const createdOrg = await createOrganization(
    control,
    actor,
    { name: "isolated move acceptance" },
    {
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    },
  );
  const tenantId = createdOrg.body.tenantId;
  assert.equal(createdOrg.status, 201);
  const route = await placement.resolveTenant(control, tenantId);
  assert.equal(route.shardId, "s1");
  const [registry] =
    await control.$queryRaw`SELECT shard_id,shard_incarnation::text AS incarnation,state FROM shard_registry WHERE shard_id IN ('s1','s2') ORDER BY shard_id`;
  const targetRegistryRows =
    await control.$queryRaw`SELECT shard_id,shard_incarnation::text AS incarnation,state FROM shard_registry WHERE shard_id='s2'`;
  const sourceRows =
    await control.$queryRaw`SELECT shard_id,shard_incarnation::text AS incarnation,state FROM shard_registry WHERE shard_id='s1'`;
  const sourceIdentity = {
    shardId: sourceRows[0].shard_id,
    incarnation: sourceRows[0].incarnation,
    epoch: "1",
  };
  const targetIdentity = {
    shardId: targetRegistryRows[0].shard_id,
    incarnation: targetRegistryRows[0].incarnation,
    epoch: "2",
  };
  assert.equal(registry.shard_id, "s1");
  assert.equal(targetRegistryRows[0].state, "active");
  console.log(
    `Prepared tenant ${tenantId} on ${route.shardId}; target ${targetIdentity.shardId} is registered.`,
  );

  const source = new pg.Pool({
    connectionString: environment.RISK_SOURCE_URL,
    max: 4,
  });
  const target = new pg.Pool({
    connectionString: environment.RISK_TARGET_URL,
    max: 4,
  });
  const adminSource = new pg.Pool({
    connectionString: environment.RISK_SOURCE_URL,
    max: 2,
  });
  const adminTarget = new pg.Pool({
    connectionString: environment.RISK_TARGET_URL,
    max: 2,
  });
  const deviceId = randomUUID();
  const otherTenant = randomUUID();
  try {
    await adminSource.query(
      `INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,'s1',$2,1,'active'),($3,'s1',$2,1,'active')`,
      [tenantId, sourceIdentity.incarnation, otherTenant],
    );
    const write = await connectScoped(source, tenantId, sourceIdentity);
    try {
      await write.query(
        `INSERT INTO device_bindings(tenant_id,device_id,status,inventory_version,binding_version,source_event_id) VALUES($1,$2,'active',1,1,$3)`,
        [tenantId, deviceId, randomUUID()],
      );
      await write.query("COMMIT");
    } finally {
      await write.query("ROLLBACK").catch(() => {});
      write.release();
    }
    const unrelatedDevice = randomUUID();
    const otherWrite = await connectScoped(source, otherTenant, sourceIdentity);
    try {
      await otherWrite.query(
        `INSERT INTO device_bindings(tenant_id,device_id,status,inventory_version,binding_version,source_event_id) VALUES($1,$2,'active',1,1,$3)`,
        [otherTenant, unrelatedDevice, randomUUID()],
      );
      await otherWrite.query("COMMIT");
    } finally {
      await otherWrite.query("ROLLBACK").catch(() => {});
      otherWrite.release();
    }

    const operationId = randomUUID();
    const lease = await leases.acquireReadLease(control, tenantId);
    const preparedReceipt = await prepareRiskMoveTarget(
      adminTarget,
      tenantId,
      operationId,
      sourceIdentity,
      targetIdentity,
    );
    assert.equal(preparedReceipt.state, "prepared");
    await assert.rejects(
      prepareRiskMoveTarget(
        adminTarget,
        tenantId,
        operationId,
        sourceIdentity,
        { ...targetIdentity, shardId: "s3" },
      ),
      /operation identity conflict/,
    );
    await assert.rejects(
      adminTarget.query(
        "SELECT greenguard_internal.activate_tenant_move_target($1::uuid,$2::uuid)",
        [tenantId, operationId],
      ),
      /requires a verified copy receipt/,
    );
    await placement.beginPlacementMove(
      control,
      tenantId,
      "1",
      "s2",
      operationId,
    );
    console.log(`Tenant ${tenantId} is quiescing for ${operationId}.`);

    // Hold the owner's shared placement admission lock to prove the exclusive
    // source fence waits for an accepted transaction.
    const accepted = await connectScoped(source, tenantId, sourceIdentity);
    try {
      await accepted.query(
        "SELECT greenguard_internal.admit_tenant_placement($1,$2,$3,$4)",
        [
          tenantId,
          sourceIdentity.shardId,
          sourceIdentity.incarnation,
          sourceIdentity.epoch,
        ],
      );
      const fenceAttempt = await adminSource.connect();
      try {
        await fenceAttempt.query("BEGIN");
        await fenceAttempt.query("SET LOCAL lock_timeout='100ms'");
        await assert.rejects(
          fenceAttempt.query(
            `UPDATE greenguard_internal.tenant_ownership SET state='fenced' WHERE tenant_id=$1`,
            [tenantId],
          ),
          /lock timeout|canceling statement/,
        );
      } finally {
        await fenceAttempt.query("ROLLBACK").catch(() => {});
        fenceAttempt.release();
      }
      await accepted.query("COMMIT");
    } finally {
      await accepted.query("ROLLBACK").catch(() => {});
      accepted.release();
    }
    // CDC history remains intentionally unmigratable. Prove both the adapter
    // preflight and the owner SQL fence refuse a different tenant with outbox rows.
    const outboxWriter = await connectScoped(adminSource, otherTenant, sourceIdentity);
    try {
      await outboxWriter.query(
        `INSERT INTO outbox_events(event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,correlation_id,causation_id,traceparent,payload) VALUES($1,$2,'device',$3,1,'risk.test',1,clock_timestamp(),$4,$5,'', '{}'::jsonb)`,
        [randomUUID(), otherTenant, unrelatedDevice, randomUUID(), randomUUID()],
      );
      await outboxWriter.query("COMMIT");
    } finally {
      await outboxWriter.query("ROLLBACK").catch(() => {});
      outboxWriter.release();
    }
    await assert.rejects(
      assertRiskMoveEffectsDrained(adminSource, otherTenant),
      /CDC outbox history/,
    );
    await assert.rejects(
      adminSource.query(
        `SELECT greenguard_internal.fence_tenant_move_source($1::uuid,$2::uuid,$3,$4::uuid,$5::bigint,$6,$7::uuid,$8::bigint)`,
        [otherTenant, randomUUID(), sourceIdentity.shardId, sourceIdentity.incarnation, sourceIdentity.epoch,
          targetIdentity.shardId, targetIdentity.incarnation, targetIdentity.epoch],
      ),
      /CDC outbox history/,
    );
    assert.equal(
      (await adminSource.query("SELECT state FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1", [otherTenant])).rows[0].state,
      "active",
    );

    const sourceFencedReceipt = await fenceRiskMoveSource(
      adminSource,
      tenantId,
      operationId,
      sourceIdentity,
      targetIdentity,
    );

    const copy = await copyRiskTenantSnapshot(
      source,
      target,
      tenantId,
      operationId,
      sourceIdentity,
      targetIdentity,
    );
    assert.equal(copy.evidence.sourceSha256, copy.evidence.targetSha256);
    assert.ok(BigInt(copy.evidence.rowCount) >= 1n);
    const copyProof = copy.receipt;
    for (const [key, proof] of [
      ["source_fenced", sourceFencedReceipt],
      ["target_prepared", preparedReceipt],
      ["copy_verified", copyProof],
    ])
      await placement.recordPlacementMoveReceipt(
        control,
        tenantId,
        operationId,
        key,
        proof,
      );
    assert.equal(
      (
        await adminTarget.query(
          "SELECT state FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1",
          [tenantId],
        )
      ).rows[0].state,
      "prepared",
    );
    await assert.rejects(
      activateRiskMoveTarget(
        adminTarget,
        tenantId,
        operationId,
        sourceIdentity,
        targetIdentity,
        await placement.resolveTenant(control, tenantId),
      ),
      /placement is not switched/,
    );
    assert.equal(
      (
        await adminTarget.query(
          "SELECT state FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1",
          [tenantId],
        )
      ).rows[0].state,
      "prepared",
    );
    await assert.rejects(
      placement.compareAndSetPlacement(
        control,
        tenantId,
        "1",
        "s2",
        operationId,
      ),
      /read leases must drain/,
    );
    await leases.releaseReadLease(control, tenantId, lease.leaseId);
    await assert.rejects(
      placement.compareAndSetPlacement(
        control,
        tenantId,
        "1",
        "s2",
        operationId,
      ),
      /operation-bound placement evidence is missing or invalid/,
    );
    const unchangedRoute = await placement.resolveTenant(control, tenantId);
    assert.equal(unchangedRoute.shardId, "s1");
    assert.equal(unchangedRoute.placementEpoch, "1");
    assert.equal(unchangedRoute.state, "quiescing");
    const unchangedMove = await placement.placementMove(
      control,
      tenantId,
      operationId,
    );
    assert.equal(unchangedMove.state, "quiescing");

    const targetRead = await connectScoped(target, tenantId, targetIdentity);
    try {
      const copied = await targetRead.query(
        "SELECT device_id::text FROM device_bindings WHERE tenant_id=$1",
        [tenantId],
      );
      assert.deepEqual(copied.rows, [{ device_id: deviceId }]);
      await targetRead.query("COMMIT");
    } finally {
      await targetRead.query("ROLLBACK").catch(() => {});
      targetRead.release();
    }
    const stale = await connectScoped(source, tenantId, sourceIdentity);
    try {
      await assert.rejects(
        stale.query(
          "UPDATE device_bindings SET status='inactive',inventory_version=2,binding_version=2 WHERE tenant_id=$1",
          [tenantId],
        ),
        /tenant placement/i,
      );
    } finally {
      await stale.query("ROLLBACK").catch(() => {});
      stale.release();
    }
    const unrelatedRead = await connectScoped(
      source,
      otherTenant,
      sourceIdentity,
    );
    try {
      assert.equal(
        (
          await unrelatedRead.query(
            "SELECT device_id::text FROM device_bindings WHERE tenant_id=$1",
            [otherTenant],
          )
        ).rows[0].device_id,
        unrelatedDevice,
      );
      await unrelatedRead.query("COMMIT");
    } finally {
      await unrelatedRead.query("ROLLBACK").catch(() => {});
      unrelatedRead.release();
    }
    const targetAbortReceipt = await abortRiskMoveTarget(
      adminTarget, tenantId, operationId, sourceIdentity, targetIdentity,
    );
    assert.equal(targetAbortReceipt.owner, "risk");
    assert.equal(targetAbortReceipt.state, "absent");
    const sourceReactivatedReceipt = await reactivateRiskMoveSource(
      adminSource, tenantId, operationId, sourceIdentity, targetIdentity, targetAbortReceipt,
    );
    assert.equal(sourceReactivatedReceipt.owner, "risk");
    assert.equal(sourceReactivatedReceipt.epoch, targetIdentity.epoch);
    assert.equal(
      (await adminTarget.query("SELECT count(*)::int AS count FROM device_bindings WHERE tenant_id=$1", [tenantId])).rows[0].count,
      0,
    );
    assert.equal(
      (await adminSource.query("SELECT state,placement_epoch::text AS epoch FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1", [tenantId])).rows[0].epoch,
      targetIdentity.epoch,
    );
    const stillQuiescing = await placement.resolveTenant(control, tenantId);
    assert.equal(stillQuiescing.state, "quiescing");
    assert.equal(stillQuiescing.placementEpoch, "1");
    console.log(
      `Risk-owner isolated acceptance passed: operation=${operationId} tables=${copy.evidence.tableCount} rows=${copy.evidence.rowCount} sha256=${copy.evidence.sourceSha256}; atomic copy receipt, CDC history refusal, source fence, abort cleanup, and epoch-advanced owner reactivation verified. Global cutover remains refused because all nine owner adapters are not integrated.`,
    );
    const abortedTarget = await abortRiskMoveTarget(
      adminTarget, tenantId, operationId, sourceIdentity, targetIdentity,
    );
    assert.equal(abortedTarget.owner, "risk");
    assert.equal(abortedTarget.state, "absent");
    const reactivatedSource = await reactivateRiskMoveSource(
      adminSource, tenantId, operationId, sourceIdentity, targetIdentity, abortedTarget,
    );
    assert.equal(reactivatedSource.owner, "risk");
    assert.equal(reactivatedSource.epoch, targetIdentity.epoch);
    assert.equal(
      (await adminTarget.query("SELECT count(*)::int AS count FROM device_bindings WHERE tenant_id=$1", [tenantId])).rows[0].count,
      0,
    );
    assert.equal(
      (await adminSource.query("SELECT state,placement_epoch::text AS epoch FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1", [tenantId])).rows[0].epoch,
      targetIdentity.epoch,
    );
    console.log("Risk owner target abort removed imported rows and source reactivated at the advanced epoch; control-plane placement remains quiescing because owner-wide receipts are incomplete.");
  } finally {
    await Promise.all([
      source.end(),
      target.end(),
      adminSource.end(),
      adminTarget.end(),
    ]);
  }
  await control.$disconnect();
} finally {
  for (const name of created.reverse()) docker(["rm", "-f", name]);
  rmSync(scratch, { recursive: true, force: true });
}
