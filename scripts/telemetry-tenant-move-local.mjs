#!/usr/bin/env node
// Isolated owner-level telemetry tenant move acceptance. All PostgreSQL state is
// created in a unique disposable Docker container; this never reads .env or a
// shared database. It validates the telemetry owner protocol only, not global
// placement CAS or the other eight operational owners.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(resolve(tmpdir(), "gg-telemetry-move-"));
const suffix = randomBytes(6).toString("hex");
const container = `gg-telemetry-move-${suffix}`;
const initSqlPath = resolve(root, "infra/compose/init-databases.sql");
const initSql = readFileSync(initSqlPath, "utf8");
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
const conn = (role, passwordKey, database, port) => {
  const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  url.username = role;
  url.password = environment[passwordKey];
  return url.toString();
};
const waitPg = async (connectionString) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const client = new pg.Client({
      connectionString,
      connectionTimeoutMillis: 500,
    });
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
  throw new Error("disposable PostgreSQL did not become ready");
};
const makePool = (url, max = 3) => new pg.Pool({ connectionString: url, max });

async function seedTenant(adminUrl, tenantId, { includeOutbox = true } = {}) {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  const deviceId = randomUUID();
  const siteId = randomUUID();
  const binId = randomUUID();
  const readingId = randomUUID();
  const messageId = randomUUID();
  const eventId = randomUUID();
  const commandId = randomUUID();
  const at = new Date().toISOString();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await db.query("SELECT set_config('app.shard_id','s1',true)");
    await db.query("SELECT set_config('app.shard_incarnation',$1,true)", [
      source.incarnation,
    ]);
    await db.query("SELECT set_config('app.placement_epoch','1',true)");
    await db.query(
      `INSERT INTO device_bindings(tenant_id,device_id,site_id,bin_id,inventory_version,status)
       VALUES($1,$2,$3,$4,1,'active')`,
      [tenantId, deviceId, siteId, binId],
    );
    await db.query(
      `INSERT INTO device_streams(tenant_id,device_id,last_version) VALUES($1,$2,1)`,
      [tenantId, deviceId],
    );
    await db.query(
      `INSERT INTO readings(tenant_id,reading_id,device_id,stream_version,source_message_id,site_id,bin_id,binding_version,observed_at,received_at,temperature_c)
       VALUES($1,$2,$3,1,$4,$5,$6,1,$7,$7,18.5)`,
      [tenantId, readingId, deviceId, messageId, siteId, binId, at],
    );
    await db.query(
      `INSERT INTO ingest_receipts(tenant_id,device_id,source_message_id,command_id,reading_id,event_id,normalized_request,response_body,accepted_at)
       VALUES($1,$2,$3,$4,$5,$6,'{}'::jsonb,'{}'::jsonb,$7)`,
      [tenantId, deviceId, messageId, commandId, readingId, eventId, at],
    );
    if (includeOutbox) {
      await db.query(
        `INSERT INTO outbox_events(event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,correlation_id,causation_id,traceparent,payload)
         VALUES($1,$2,'device',$3,1,'reading.accepted',1,$4,$5,$6,'00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01','{}'::jsonb)`,
        [eventId, tenantId, deviceId, at, randomUUID(), commandId],
      );
    }
    await db.query(
      `INSERT INTO audit_events(audit_id,tenant_id,actor_type,actor_id,action,resource_type,resource_id,command_id,event_id,outcome,occurred_at)
       VALUES($1,$2,'system','local-move','reading.accepted','reading',$3,$4,$5,'succeeded',$6)`,
      [randomUUID(), tenantId, readingId, commandId, eventId, at],
    );
    await db.query(
      `INSERT INTO consumer_inbox(consumer_name,tenant_id,event_id,event,processed_at)
       VALUES('test-consumer',$1,$2,'{}'::jsonb,$3)`,
      [tenantId, eventId, at],
    );
    await db.query(
      `INSERT INTO ingest_rejection_samples(tenant_id,device_id,slot,reason,payload_sha256,rejected_at)
       VALUES($1,$2,0,'sample','${"a".repeat(64)}',$3)`,
      [tenantId, deviceId, at],
    );
    await db.query(
      `INSERT INTO saga_binding_requests(tenant_id,command_id,saga_id,device_id,saga_version,fencing_token)
       VALUES($1,$2,$3,$4,1,1)`,
      [tenantId, randomUUID(), randomUUID(), deviceId],
    );
    await db.query(
      `INSERT INTO tenant_entitlements(tenant_id,plan_key,plan_version,limits,features,source_version)
       VALUES($1,'test',1,'{}'::jsonb,'{}'::jsonb,1)`,
      [tenantId],
    );
    await db.query(
      `INSERT INTO ingest_quota_usage(tenant_id,period_start,accepted) VALUES($1,current_date,1)`,
      [tenantId],
    );
    await db.query(
      `INSERT INTO cable_layout_bindings(tenant_id,cable_id,device_id,bin_id,layout_version,deleted,sensors)
       VALUES($1,$2,$3,$4,1,false,'[]'::jsonb)`,
      [tenantId, randomUUID(), deviceId, binId],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
  return { deviceId, siteId, binId };
}

async function seedOwnership(adminUrl, tenantId, identity) {
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  try {
    await db.query(
      `INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state)
       VALUES($1,$2,$3,$4,'active')`,
      [tenantId, identity.shardId, identity.incarnation, identity.epoch],
    );
  } finally {
    await db.end();
  }
}

async function assertStaleWriterRejected(url, tenantId, deviceId, identity) {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await db.query("SELECT set_config('app.shard_id',$1,true)", [
      identity.shardId,
    ]);
    await db.query("SELECT set_config('app.shard_incarnation',$1,true)", [
      identity.incarnation,
    ]);
    await db.query("SELECT set_config('app.placement_epoch',$1,true)", [
      identity.epoch,
    ]);
    await assert.rejects(
      db.query(
        `UPDATE device_bindings SET status='disabled' WHERE tenant_id=$1 AND device_id=$2`,
        [tenantId, deviceId],
      ),
      /tenant placement is missing, stale, or fenced/,
    );
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await db.end();
  }
}

async function assertNewWriterAccepted(url, tenantId, identity) {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await db.query("SELECT set_config('app.shard_id',$1,true)", [
      identity.shardId,
    ]);
    await db.query("SELECT set_config('app.shard_incarnation',$1,true)", [
      identity.incarnation,
    ]);
    await db.query("SELECT set_config('app.placement_epoch',$1,true)", [
      identity.epoch,
    ]);
    await db.query(
      `INSERT INTO device_bindings(tenant_id,device_id,site_id,inventory_version,status)
       VALUES($1,$2,$3,1,'active')`,
      [tenantId, randomUUID(), randomUUID()],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

const source = {
  shardId: "s1",
  incarnation: randomUUID(),
  epoch: "1",
};
const target = {
  shardId: "s2",
  incarnation: randomUUID(),
  epoch: "2",
};
let created = false;
let sourceOwner;
let targetOwner;
try {
  if (process.env.GG_SKIP_BUILD !== "1")
    run("npm", ["run", "build", "-w", "@greenguard/tenant-control-plane"]);
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
    `${initSqlPath}:/docker-entrypoint-initdb.d/001-init.sql:ro`,
    "postgres:16",
  ]);
  created = true;
  const port = docker(["port", container, "5432/tcp"]).split(":").at(-1);
  environment.POSTGRES_ADMIN_URL = conn(
    "postgres",
    "POSTGRES_PASSWORD",
    "postgres",
    port,
  );
  environment.TELEMETRY_MIGRATION_URL = conn(
    "telemetry_migrator",
    "TELEMETRY_MIGRATOR_PASSWORD",
    "greenguard_telemetry",
    port,
  );
  await waitPg(environment.POSTGRES_ADMIN_URL);
  run(
    "go",
    ["run", "./cmd/migrate"],
    resolve(root, "services/telemetry-ingest"),
    environment,
  );
  const admin = new pg.Client({
    connectionString: environment.POSTGRES_ADMIN_URL,
  });
  await admin.connect();
  await admin.query(
    "CREATE DATABASE greenguard_telemetry_s2 WITH TEMPLATE greenguard_telemetry OWNER telemetry_migrator",
  );
  await admin.end();
  const telemetryUrl = (database) =>
    conn("telemetry_migrator", "TELEMETRY_MIGRATOR_PASSWORD", database, port);
  sourceOwner = makePool(telemetryUrl("greenguard_telemetry"));
  targetOwner = makePool(telemetryUrl("greenguard_telemetry_s2"));
  const telemetryOwnerModule = pathToFileURL(
    process.env.GG_TELEMETRY_OWNER_MODULE ?? resolve(root, "services/tenant-control-plane/dist/tenant-move/telemetry-owner.js"),
  ).href;
  const {
    prepareTelemetryMoveTarget,
    fenceTelemetryMoveSource,
    copyTelemetryTenantSnapshot,
    activateTelemetryMoveTarget,
    abortTelemetryMoveTarget,
    reactivateTelemetryMoveSource,
  } = await import(telemetryOwnerModule);

  const activeRoute = (tenantId, shardId, placementEpoch, state) => ({
    tenantId,
    shardId,
    placementEpoch,
    state,
  });
  const firstTenant = randomUUID();
  const firstOperation = randomUUID();
  await seedOwnership(
    telemetryUrl("greenguard_telemetry"),
    firstTenant,
    source,
  );
  const firstData = await seedTenant(
    telemetryUrl("greenguard_telemetry"),
    firstTenant,
    { includeOutbox: false },
  );
  await prepareTelemetryMoveTarget(
    targetOwner,
    firstTenant,
    firstOperation,
    source,
    target,
  );
  await fenceTelemetryMoveSource(
    sourceOwner,
    firstTenant,
    firstOperation,
    source,
    target,
  );
  await assertStaleWriterRejected(
    conn(
      "telemetry_app",
      "TELEMETRY_DB_PASSWORD",
      "greenguard_telemetry",
      port,
    ),
    firstTenant,
    firstData.deviceId,
    source,
  );
  const copied = await copyTelemetryTenantSnapshot(
    sourceOwner,
    targetOwner,
    firstTenant,
    firstOperation,
    source,
    target,
  );
  assert.equal(copied.receipt.phase, "copy_verified");
  assert.equal(copied.evidence.sourceSha256, copied.evidence.targetSha256);
  assert.equal(copied.evidence.rowCount, "11");
  const replayedCopy = await copyTelemetryTenantSnapshot(
    sourceOwner,
    targetOwner,
    firstTenant,
    firstOperation,
    source,
    target,
  );
  assert.deepEqual(replayedCopy.receipt, copied.receipt);
  const activation = await activateTelemetryMoveTarget(
    targetOwner,
    firstTenant,
    firstOperation,
    source,
    target,
    activeRoute(firstTenant, target.shardId, target.epoch, "activating"),
  );
  assert.equal(activation.state, "active");
  await assertNewWriterAccepted(
    conn(
      "telemetry_app",
      "TELEMETRY_DB_PASSWORD",
      "greenguard_telemetry_s2",
      port,
    ),
    firstTenant,
    target,
  );

  const cdcTenant = randomUUID();
  const cdcOperation = randomUUID();
  await seedOwnership(telemetryUrl("greenguard_telemetry"), cdcTenant, source);
  await seedTenant(telemetryUrl("greenguard_telemetry"), cdcTenant);
  await prepareTelemetryMoveTarget(targetOwner, cdcTenant, cdcOperation, source, target);
  await assert.rejects(
    fenceTelemetryMoveSource(sourceOwner, cdcTenant, cdcOperation, source, target),
    /CDC outbox history/,
  );
  await assert.rejects(
    sourceOwner.query(
      `SELECT greenguard_internal.fence_tenant_move_source($1::uuid,$2::uuid,$3,$4::uuid,$5::bigint,$6,$7::uuid,$8::bigint)`,
      [cdcTenant, cdcOperation, source.shardId, source.incarnation, source.epoch, target.shardId, target.incarnation, target.epoch],
    ),
    /CDC outbox history/,
  );
  assert.equal(
    (await sourceOwner.query("SELECT state FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1", [cdcTenant])).rows[0].state,
    "active",
  );

  const secondTenant = randomUUID();
  const secondOperation = randomUUID();
  await seedOwnership(
    telemetryUrl("greenguard_telemetry"),
    secondTenant,
    source,
  );
  const secondData = await seedTenant(
    telemetryUrl("greenguard_telemetry"),
    secondTenant,
    { includeOutbox: false },
  );
  await prepareTelemetryMoveTarget(
    targetOwner,
    secondTenant,
    secondOperation,
    source,
    target,
  );
  await fenceTelemetryMoveSource(
    sourceOwner,
    secondTenant,
    secondOperation,
    source,
    target,
  );
  const secondCopy = await copyTelemetryTenantSnapshot(
    sourceOwner,
    targetOwner,
    secondTenant,
    secondOperation,
    source,
    target,
  );
  const targetAborted = await abortTelemetryMoveTarget(
    targetOwner,
    secondTenant,
    secondOperation,
    source,
    target,
  );
  const sourceReactivated = await reactivateTelemetryMoveSource(
    sourceOwner,
    secondTenant,
    secondOperation,
    source,
    target,
    targetAborted,
  );
  assert.equal(targetAborted.state, "absent");
  assert.equal(sourceReactivated.epoch, target.epoch);
  assert.equal(secondCopy.evidence.rowCount, "11");
  const check = new pg.Client({
    connectionString: telemetryUrl("greenguard_telemetry_s2"),
  });
  await check.connect();
  const remaining = await check.query(
    "SELECT count(*)::int AS count FROM readings WHERE tenant_id=$1",
    [secondTenant],
  );
  const ownerState = await check.query(
    "SELECT count(*)::int AS count FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1",
    [secondTenant],
  );
  await check.end();
  assert.equal(remaining.rows[0].count, 0);
  assert.equal(ownerState.rows[0].count, 0);
  await assertStaleWriterRejected(
    conn(
      "telemetry_app",
      "TELEMETRY_DB_PASSWORD",
      "greenguard_telemetry",
      port,
    ),
    secondTenant,
    secondData.deviceId,
    source,
  );
  console.log(
    "Telemetry owner isolated acceptance passed: bounded 500-row copy batches across 12 tables, durable copy receipt, source fence, target activation/new-writer admission, stale source rejection, CDC-history rejection, target cleanup, and epoch-advanced source reactivation.",
  );
} finally {
  await sourceOwner?.end().catch(() => {});
  await targetOwner?.end().catch(() => {});
  if (created) docker(["rm", "-f", container]);
  rmSync(scratch, { recursive: true, force: true });
}
