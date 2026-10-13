/** Disposable-only restore mechanism experiment. Not an operator command or a
 * production capability: no environment DSNs accepted and no authority changes.
 * Real inventory migrations remain untouched. Fixture-only SQL models a future
 * restore capability while retaining existing ownership and FORCE-RLS checks. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import {
  INVENTORY_RESTORE_TABLES,
  deriveLocalShardIncarnation,
} from "../preflight.js";
const image =
  "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea";
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  }).trim();
const owned: string[] = [],
  clients: pg.Client[] = [];
const password = randomUUID(),
  tenant = randomUUID(),
  foreign = randomUUID(),
  operation = randomUUID(),
  old = randomUUID(),
  device = randomUUID(),
  site = randomUUID(),
  event = randomUUID(),
  command = randomUUID();
const report = {
  disposableOnly: true,
  liveMutations: 0,
  executionAllowed: false,
  checks: 0,
};
function check(condition: unknown) {
  assert.ok(condition);
  report.checks++;
}
async function connect(url: string) {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 2000,
    query_timeout: 4000,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end();
    throw error;
  }
  clients.push(client);
  return client;
}
async function database(label: string) {
  const name = `greenguard-restore-proof-${label}-${randomUUID().slice(0, 8)}`;
  const id = docker(
    "run",
    "--pull=never",
    "-d",
    "--name",
    name,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=greenguard_inventory",
    "-p",
    "127.0.0.1::5432",
    image,
  );
  owned.push(id);
  const port = docker("port", id, "5432/tcp").split(":").at(-1)!;
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/greenguard_inventory`;
  let admin: pg.Client | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      admin = await connect(url);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!admin) throw new Error("owned disposable database not ready");
  await admin.query(
    "CREATE ROLE inventory_app LOGIN;CREATE ROLE inventory_migrator LOGIN;CREATE ROLE inventory_projector;CREATE ROLE inventory_audit_reader;CREATE ROLE cdc_reader;CREATE ROLE tenant_ownership_bootstrap;CREATE ROLE fixture_restore LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
  );
  // Random UUID is internal fixture data, never an external SQL credential.
  await admin.query(
    `ALTER ROLE fixture_restore PASSWORD '${password}'; ALTER ROLE inventory_app PASSWORD '${password}'`,
  );
  const migrations = new URL(
    "./services/device-service/prisma/migrations/",
    new URL("file://" + process.cwd() + "/"),
  );
  for (const version of readdirSync(migrations)
    .filter((v) => /^\d/.test(v))
    .sort())
    await admin.query(
      readFileSync(new URL(`${version}/migration.sql`, migrations), "utf8"),
    );
  await admin.query(
    "SELECT greenguard_internal.assert_tenant_fences_installed()",
  );
  const runtime = new URL(url);
  runtime.username = "inventory_app";
  const restore = new URL(url);
  restore.username = "fixture_restore";
  return { admin, runtime: runtime.href, restore: restore.href };
}
async function context(db: pg.Client, t: string, inc: string, op?: string) {
  await db.query(
    "SELECT set_config('app.tenant_id',$1,true),set_config('app.shard_id','s1',true),set_config('app.shard_incarnation',$2,true),set_config('app.placement_epoch','1',true),set_config('app.restore_operation_id',$3,true)",
    [t, inc, op ?? ""],
  );
}
async function rejects(
  work: () => Promise<unknown>,
  expected: RegExp | { code: string },
) {
  await assert.rejects(work, expected);
  report.checks++;
}
async function transaction(
  db: pg.Client,
  work: () => Promise<unknown>,
  readOnly = false,
) {
  await db.query(
    readOnly
      ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL lock_timeout='500ms'"
      : "BEGIN;SET LOCAL lock_timeout='500ms'",
  );
  try {
    const value = await work();
    await db.query("COMMIT");
    return value;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
type Snapshot = { name: string; rows: string[] }[];
async function snapshot(db: pg.Client, t: string): Promise<Snapshot> {
  const tables = (
    await db.query(
      "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' ORDER BY table_name",
    )
  ).rows.map((r) => r.table_name);
  assert.deepEqual(tables, [...INVENTORY_RESTORE_TABLES]);
  const result: Snapshot = [];
  for (const name of tables) {
    const rows = await db.query(
      `SELECT row_to_json(t)::text AS body FROM public."${name}" t WHERE tenant_id=$1 ORDER BY row_to_json(t)::text LIMIT 101`,
      [t],
    );
    if (rows.rowCount! > 100) throw new Error("fixture size exceeded");
    result.push({ name, rows: rows.rows.map((r) => r.body) });
  }
  return result;
}
const hash = (value: Snapshot) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
try {
  const source = await database("source"),
    target = await database("target");
  const systemId = (
    await target.admin.query(
      "SELECT system_identifier::text AS id FROM pg_control_system()",
    )
  ).rows[0].id;
  const current = deriveLocalShardIncarnation(
    "greenguard-sharding-proof",
    "s1",
    systemId,
  );
  check(
    (
      await source.admin.query(
        "SELECT system_identifier::text AS id FROM pg_control_system()",
      )
    ).rows[0].id !== systemId,
  );
  for (const t of [tenant, foreign])
    await source.admin.query(
      "INSERT INTO greenguard_internal.tenant_ownership VALUES($1,'s1',$2,1,'active',clock_timestamp())",
      [t, old],
    );
  await transaction(source.admin, async () => {
    await context(source.admin, tenant, old);
    await source.admin.query(
      "INSERT INTO tenants(tenant_id,name) VALUES($1,'fixture')",
      [tenant],
    );
    await source.admin.query(
      "INSERT INTO sites(tenant_id,site_id,name) VALUES($1,$2,'site')",
      [tenant, site],
    );
    await source.admin.query(
      "INSERT INTO devices(tenant_id,device_id,site_id,serial_number,status,binding_version,created_at,updated_at) VALUES($1,$2,$3,'SYNTHETIC-RESTORE','active',9007199254740993,'2026-10-04T12:00:00.123456Z','2026-10-04T12:00:00.654321Z')",
      [tenant, device, site],
    );
    await source.admin.query(
      "INSERT INTO command_receipts VALUES($1,'original-key','device.register',$2,'{\"request\":\"fixture\"}','{\"accepted\":true}','2026-10-04T12:00:00.123456Z')",
      [tenant, command],
    );
    await source.admin.query(
      "INSERT INTO outbox_events(event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,correlation_id,causation_id,traceparent,payload) VALUES($1,$2,'device',$3,9007199254740993,'device.registered',1,'2026-10-04T12:00:00.123456Z',$4,$4,'00-11111111111111111111111111111111-2222222222222222-01','{\"synthetic\":true}')",
      [event, tenant, device, command],
    );
  });
  await transaction(source.admin, async () => {
    await context(source.admin, tenant, old);
    await source.admin.query(
      "INSERT INTO audit_events VALUES($1,$2,'human','synthetic','device.register','device',$3,$4,$5,'succeeded','2026-10-04T12:00:00.123456Z')",
      [randomUUID(), tenant, device, command, event],
    );
    await source.admin.query(
      "INSERT INTO inventory_saga_receipts VALUES($1,$2,$3,$4,$5,'inventory.activate',1,1,'succeeded',$6,'2026-10-04T12:00:00.123456Z')",
      [tenant, command, operation, device, site, event],
    );
    await source.admin.query(
      "INSERT INTO inventory_saga_result_outbox(tenant_id,result_id,command_id,saga_id,step,saga_version,fencing_token,outcome,created_at,published_at,traceparent) VALUES($1,$2,$3,$4,'inventory.activate',1,1,'succeeded','2026-10-04T12:00:00.123456Z','2026-10-04T12:00:01.654321Z','00-11111111111111111111111111111111-2222222222222222-01')",
      [tenant, event, command, operation],
    );
  });
  await transaction(source.admin, async () => {
    await context(source.admin, foreign, old);
    await source.admin.query(
      "INSERT INTO tenants(tenant_id,name) VALUES($1,'foreign preserved')",
      [foreign],
    );
  });
  const runtime = await connect(source.runtime);
  await runtime.query("BEGIN");
  await context(runtime, tenant, old);
  await runtime.query(
    "SELECT greenguard_internal.admit_tenant_placement($1,'s1',$2,1)",
    [tenant, old],
  );
  await rejects(
    () =>
      transaction(source.admin, () =>
        source.admin.query(
          "UPDATE greenguard_internal.tenant_ownership SET state='fenced' WHERE tenant_id=$1",
          [tenant],
        ),
      ),
    { code: "55P03" },
  );
  await runtime.query("COMMIT");
  await source.admin.query(
    "UPDATE greenguard_internal.tenant_ownership SET state='fenced' WHERE tenant_id=$1",
    [tenant],
  );
  await rejects(
    () =>
      transaction(runtime, async () => {
        await context(runtime, tenant, old);
        return runtime.query(
          "UPDATE devices SET status='disabled' WHERE tenant_id=$1 AND device_id=$2",
          [tenant, device],
        );
      }),
    { code: "42501" },
  );
  const preserved = (await transaction(
    source.admin,
    () => snapshot(source.admin, tenant),
    true,
  )) as Snapshot;
  const sourceHash = hash(preserved);
  const foreignBefore = hash(await snapshot(source.admin, foreign));
  await target.admin.query(
    "CREATE TABLE greenguard_internal.fixture_restore_receipts(tenant_id uuid PRIMARY KEY,operation_id uuid UNIQUE NOT NULL,source_sha text NOT NULL,target_incarnation uuid NOT NULL,state text NOT NULL CHECK(state IN('prepared','copy_verified')),copied_sha text);REVOKE ALL ON greenguard_internal.fixture_restore_receipts FROM PUBLIC;GRANT USAGE ON SCHEMA greenguard_internal TO fixture_restore;GRANT SELECT ON greenguard_internal.fixture_restore_receipts TO fixture_restore;",
  );
  await target.admin.query(
    "ALTER TABLE greenguard_internal.fixture_restore_receipts ENABLE ROW LEVEL SECURITY;ALTER TABLE greenguard_internal.fixture_restore_receipts FORCE ROW LEVEL SECURITY;CREATE POLICY fixture_receipt_scope ON greenguard_internal.fixture_restore_receipts USING(tenant_id::text=current_setting('app.tenant_id',true) AND operation_id::text=current_setting('app.restore_operation_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND operation_id::text=current_setting('app.restore_operation_id',true))",
  );
  await target.admin.query(
    "INSERT INTO greenguard_internal.fixture_restore_receipts VALUES($1,$2,$3,$4,'prepared',NULL)",
    [tenant, operation, sourceHash, current],
  );
  await target.admin.query(
    "INSERT INTO greenguard_internal.tenant_ownership VALUES($1,'s1',$2,1,'prepared',clock_timestamp())",
    [tenant, current],
  );
  // Fixture-only capability branch, retaining existing admission for every other
  // login. Restricted role has INSERT/SELECT only, no ledger INSERT or ownership.
  const original = (
    await target.admin.query(
      "SELECT pg_get_functiondef('greenguard_internal.admit_tenant_placement(uuid,text,uuid,bigint)'::regprocedure) AS body",
    )
  ).rows[0].body as string;
  const capability = `BEGIN\n IF session_user='fixture_restore' AND p_tenant_id::text=current_setting('app.tenant_id',true) THEN
 IF EXISTS(SELECT 1 FROM greenguard_internal.fixture_restore_receipts r JOIN greenguard_internal.tenant_ownership o USING(tenant_id)
 WHERE r.tenant_id=p_tenant_id AND r.operation_id::text=current_setting('app.restore_operation_id',true) AND r.state='prepared'
 AND o.shard_id=p_shard_id AND o.shard_incarnation=p_incarnation AND o.placement_epoch=p_epoch AND o.state='prepared'
 AND r.target_incarnation=p_incarnation) THEN RETURN;END IF;END IF;`;
  await target.admin.query(original.replace("BEGIN", capability));
  for (const name of INVENTORY_RESTORE_TABLES)
    await target.admin.query(
      `GRANT SELECT,INSERT ON public."${name}" TO fixture_restore`,
    );
  await target.admin
    .query(`CREATE FUNCTION greenguard_internal.record_fixture_copy(t uuid,op uuid,sha text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,greenguard_internal AS $$ BEGIN
 IF t::text IS DISTINCT FROM current_setting('app.tenant_id',true) OR op::text IS DISTINCT FROM current_setting('app.restore_operation_id',true) THEN RAISE EXCEPTION 'receipt context mismatch'; END IF;
 UPDATE greenguard_internal.fixture_restore_receipts SET state='copy_verified',copied_sha=sha WHERE tenant_id=t AND operation_id=op AND state='prepared' AND source_sha=sha;
 IF NOT FOUND THEN RAISE EXCEPTION 'receipt mismatch or terminal replay';END IF;END $$;REVOKE ALL ON FUNCTION greenguard_internal.record_fixture_copy(uuid,uuid,text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION greenguard_internal.record_fixture_copy(uuid,uuid,text) TO fixture_restore`);
  const restorer = await connect(target.restore);
  const copy = async (op: string, fail = false) =>
    transaction(restorer, async () => {
      await context(restorer, tenant, current, op);
      await restorer.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [tenant],
      );
      const receipt = (
        await restorer.query(
          "SELECT source_sha,state,copied_sha FROM greenguard_internal.fixture_restore_receipts WHERE tenant_id=$1 AND operation_id=$2",
          [tenant, op],
        )
      ).rows[0];
      if (
        !receipt ||
        receipt.source_sha !== sourceHash ||
        receipt.state !== "prepared"
      )
        throw new Error("receipt conflict or terminal replay");
      for (const table of preserved)
        if (
          (
            await restorer.query(
              `SELECT 1 FROM public."${table.name}" WHERE tenant_id=$1 LIMIT 1`,
              [tenant],
            )
          ).rowCount
        )
          throw new Error("target not empty");
      // FK order for populated fixture tables; all15 tables are verified by snapshot.
      for (const name of [
        "tenants",
        "sites",
        "devices",
        "command_receipts",
        "outbox_events",
        "audit_events",
        "inventory_saga_receipts",
        "inventory_saga_result_outbox",
      ]) {
        for (const body of preserved.find((t) => t.name === name)!.rows)
          await restorer.query(
            `INSERT INTO public."${name}" SELECT * FROM json_populate_record(NULL::public."${name}",$1::json)`,
            [body],
          );
        if (fail && name === "devices")
          throw new Error("injected pre-commit crash");
      }
      const copied = await snapshot(restorer, tenant);
      if (hash(copied) !== sourceHash) throw new Error("content mismatch");
      await restorer.query(
        "SELECT greenguard_internal.record_fixture_copy($1,$2,$3)",
        [tenant, op, hash(copied)],
      );
    });
  await rejects(
    () => copy(randomUUID()),
    /receipt conflict or terminal replay/,
  );
  await rejects(() => copy(operation, true), /injected pre-commit crash/);
  check(
    hash(await snapshot(target.admin, tenant)) ===
      hash(INVENTORY_RESTORE_TABLES.map((name) => ({ name, rows: [] }))),
  );
  check(
    (
      await target.admin.query(
        "SELECT state,copied_sha FROM greenguard_internal.fixture_restore_receipts WHERE tenant_id=$1",
        [tenant],
      )
    ).rows[0].state === "prepared",
  );
  await copy(operation);
  check(hash(await snapshot(target.admin, tenant)) === sourceHash);
  check(
    (
      await target.admin.query(
        "SELECT copied_sha FROM greenguard_internal.fixture_restore_receipts WHERE tenant_id=$1",
        [tenant],
      )
    ).rows[0].copied_sha === sourceHash,
  );
  await rejects(
    () =>
      transaction(restorer, async () => {
        await context(restorer, tenant, current, operation);
        return restorer.query(
          "UPDATE greenguard_internal.fixture_restore_receipts SET state='prepared' WHERE tenant_id=$1",
          [tenant],
        );
      }),
    { code: "42501" },
  );
  await rejects(
    () =>
      transaction(restorer, async () => {
        await context(restorer, tenant, current, operation);
        return restorer.query("DELETE FROM devices WHERE tenant_id=$1", [
          tenant,
        ]);
      }),
    { code: "42501" },
  );
  await rejects(
    () =>
      transaction(restorer, async () => {
        await context(restorer, tenant, current, operation);
        return restorer.query(
          "INSERT INTO tenants(tenant_id,name) VALUES($1,'cross tenant denied')",
          [foreign],
        );
      }),
    { code: "42501" },
  );
  await transaction(restorer, async () => {
    await context(restorer, foreign, current, operation);
    check(
      (
        await restorer.query(
          "SELECT count(*)::int AS n FROM devices WHERE tenant_id=$1",
          [tenant],
        )
      ).rows[0].n === 0,
    );
  });
  await rejects(() => copy(operation), /receipt conflict or terminal replay/);
  await rejects(
    () => copy(randomUUID()),
    /receipt conflict or terminal replay/,
  );
  check(hash(await snapshot(source.admin, tenant)) === sourceHash);
  check(hash(await snapshot(source.admin, foreign)) === foreignBefore);
  check(
    (
      await target.admin.query(
        "SELECT count(*)::int AS n FROM tenants WHERE tenant_id=$1",
        [foreign],
      )
    ).rows[0].n === 0,
  );
  check(
    (
      await target.admin.query(
        "SELECT binding_version::text AS v,to_char(created_at,'US') AS micro FROM devices WHERE tenant_id=$1",
        [tenant],
      )
    ).rows[0].v === "9007199254740993",
  );
  check(
    (
      await target.admin.query(
        "SELECT binding_version::text AS v,to_char(created_at,'US') AS micro FROM devices WHERE tenant_id=$1",
        [tenant],
      )
    ).rows[0].micro === "123456",
  );
  // A synthetic downstream receipt/effect transaction proves duplicate transport
  // delivery does not duplicate the effect and conflicting original identity fails.
  await target.admin.query(
    "CREATE TABLE greenguard_internal.fixture_cdc_inbox(tenant_id uuid,event_id uuid,payload_sha text,PRIMARY KEY(tenant_id,event_id));CREATE TABLE greenguard_internal.fixture_cdc_effects(tenant_id uuid,event_id uuid,PRIMARY KEY(tenant_id,event_id))",
  );
  const duplicateUrl = new URL(target.restore);
  duplicateUrl.username = "postgres";
  const duplicate = await connect(duplicateUrl.href);
  const deliver = async (
    payloadSha: string,
    fail = false,
    consumer = target.admin,
  ) =>
    transaction(consumer, async () => {
      const inserted = await consumer.query(
        "INSERT INTO greenguard_internal.fixture_cdc_inbox VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id",
        [tenant, event, payloadSha],
      );
      const existing = (
        await consumer.query(
          "SELECT payload_sha FROM greenguard_internal.fixture_cdc_inbox WHERE tenant_id=$1 AND event_id=$2 FOR UPDATE",
          [tenant, event],
        )
      ).rows[0];
      if (!existing || existing.payload_sha !== payloadSha)
        throw new Error("conflicting CDC replay");
      if (!inserted.rowCount) return;
      if (fail) throw new Error("injected CDC crash");
      await consumer.query(
        "INSERT INTO greenguard_internal.fixture_cdc_effects VALUES($1,$2)",
        [tenant, event],
      );
    });
  await rejects(() => deliver(sourceHash, true), /injected CDC crash/);
  check(
    (
      await target.admin.query(
        "SELECT count(*)::int AS n FROM greenguard_internal.fixture_cdc_inbox WHERE tenant_id=$1",
        [tenant],
      )
    ).rows[0].n === 0,
  );
  await Promise.all([
    deliver(sourceHash),
    deliver(sourceHash, false, duplicate),
  ]);
  await deliver(sourceHash);
  await rejects(() => deliver("b".repeat(64)), /conflicting CDC replay/);
  check(
    (
      await target.admin.query(
        "SELECT count(*)::int AS n FROM greenguard_internal.fixture_cdc_effects WHERE tenant_id=$1 AND event_id=$2",
        [tenant, event],
      )
    ).rows[0].n === 1,
  );
  check(
    (
      await target.admin.query(
        "SELECT state FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1",
        [tenant],
      )
    ).rows[0].state === "prepared",
  );
  console.log(JSON.stringify(report));
} finally {
  for (const client of clients) await client.end().catch(() => {});
  for (const id of owned) {
    try {
      docker("rm", "-fv", id);
    } catch {
      console.error("owned disposable container cleanup failed");
      process.exitCode = 1;
    }
  }
}
