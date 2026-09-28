import { admitOwnerPlacement } from "@greenguard/membership-client/owner-db";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { adminUrl, env } from "./testing/fixtures.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

function prisma(args: string[], migrationUrl: string, migrationPath?: string) {
  return spawnSync("npx", ["prisma", ...args], {
    cwd: packageDir,
    env: {
      ...process.env,
      INVENTORY_MIGRATION_URL: migrationUrl,
      ...(migrationPath && { INVENTORY_MIGRATIONS_PATH: migrationPath }),
    },
    encoding: "utf8",
  });
}

async function admin(database: string, sql: string) {
  const client = new pg.Client({ connectionString: adminUrl(database) });
  await client.connect();
  try {
    return (await client.query(sql)).rows;
  } finally {
    await client.end();
  }
}

test("D01: migrations build an empty database, re-apply cleanly and match the schema", async () => {
  const scratch = `greenguard_inventory_d01_${randomBytes(4).toString("hex")}`;
  const url = new URL(env("INVENTORY_MIGRATION_URL"));
  url.pathname = `/${scratch}`;
  await admin(
    "postgres",
    `CREATE DATABASE ${scratch} OWNER inventory_migrator`,
  );
  try {
    const first = prisma(["migrate", "deploy"], url.toString());
    assert.equal(first.status, 0, first.stderr);
    const second = prisma(["migrate", "deploy"], url.toString());
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /No pending migrations/);
    const drift = prisma(
      [
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        "prisma/schema.prisma",
        "--exit-code",
      ],
      url.toString(),
    );
    assert.equal(drift.status, 0, drift.stdout + drift.stderr);
    const policies = await admin(
      scratch,
      "SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 'tenant_isolation'",
    );
    assert.equal(policies[0].n, 15);
    const versions = await admin(
      scratch,
      `SELECT table_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name IN ('sites', 'bins') AND column_name = 'version' ORDER BY table_name`,
    );
    assert.deepEqual(
      versions,
      ["bins", "sites"].map((table_name) => ({
        table_name,
        data_type: "bigint",
        is_nullable: "NO",
        column_default: "1",
      })),
    );
    const forced = await admin(
      scratch,
      `SELECT relname, relrowsecurity AND relforcerowsecurity AS forced
      FROM pg_class WHERE relname IN ('sites', 'bins') ORDER BY relname`,
    );
    assert.deepEqual(forced, [
      { relname: "bins", forced: true },
      { relname: "sites", forced: true },
    ]);
    const cdcPolicies = await admin(
      scratch,
      "SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 'cdc_outbox_snapshot'",
    );
    assert.equal(cdcPolicies[0].n, 1);
  } finally {
    await admin("postgres", `DROP DATABASE ${scratch} WITH (FORCE)`);
  }
});

test("M11: existing inventory tenants upgrade into version-one control-plane projections", async () => {
  const scratch = `greenguard_inventory_m11_${randomBytes(4).toString("hex")}`;
  const url = new URL(env("INVENTORY_MIGRATION_URL"));
  url.pathname = `/${scratch}`;
  const oldMigrations = mkdtempSync(join(tmpdir(), "inventory-before-09a-"));
  const source = join(packageDir, "prisma", "migrations");
  for (const entry of readdirSync(source)) {
    if (
      entry !== "migration_lock.toml" &&
      entry >= "20260925110000_tenant_projection"
    )
      continue;
    cpSync(join(source, entry), join(oldMigrations, entry), {
      recursive: true,
    });
  }
  await admin(
    "postgres",
    `CREATE DATABASE ${scratch} OWNER inventory_migrator`,
  );
  try {
    const before = prisma(["migrate", "deploy"], url.toString(), oldMigrations);
    assert.equal(before.status, 0, before.stderr);
    const tenantId = "49d2e2e6-3697-4297-bc89-691bf8d9321e";
    await admin(
      scratch,
      `INSERT INTO tenants (tenant_id,name) VALUES ('${tenantId}', 'legacy farm')`,
    );
    const upgrade = prisma(["migrate", "deploy"], url.toString());
    assert.equal(upgrade.status, 0, upgrade.stderr);
    const rows = await admin(
      scratch,
      `SELECT name,state,home_region,version::text FROM tenants WHERE tenant_id='${tenantId}'`,
    );
    assert.deepEqual(rows, [
      {
        name: "legacy farm",
        state: "active",
        home_region: "local",
        version: "1",
      },
    ]);
    const replay = prisma(["migrate", "deploy"], url.toString());
    assert.equal(replay.status, 0, replay.stderr);
  } finally {
    rmSync(oldMigrations, { recursive: true, force: true });
    await admin("postgres", `DROP DATABASE ${scratch} WITH (FORCE)`);
  }
});

// Exercise the actual role under forced RLS in both owning databases. Existing
// D02/D03 tests continue to prove that runtime roles cannot cross tenants.
test("R1: CDC can snapshot both tenants' outbox rows and nothing else", async () => {
  for (const database of ["inventory", "telemetry"]) {
    const client = new pg.Client({
      connectionString: adminUrl(`greenguard_${database}`),
    });
    await client.connect();
    try {
      await client.query("BEGIN");
      const role =
        await client.query(`SELECT rolcanlogin, rolreplication, rolsuper,
        rolcreatedb, rolcreaterole, rolbypassrls, rolinherit
        FROM pg_roles WHERE rolname = 'cdc_reader'`);
      assert.deepEqual(role.rows, [
        {
          rolcanlogin: true,
          rolreplication: true,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
          rolinherit: false,
        },
      ]);
      const policy =
        await client.query(`SELECT tablename, cmd, roles::text[], qual
        FROM pg_policies WHERE policyname = 'cdc_outbox_snapshot'`);
      assert.deepEqual(policy.rows, [
        {
          tablename: "outbox_events",
          cmd: "SELECT",
          roles: ["cdc_reader"],
          qual: "true",
        },
      ]);
      const grants = await client.query(`SELECT relname FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
        AND has_table_privilege('cdc_reader', oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        ORDER BY relname`);
      assert.deepEqual(grants.rows, [{ relname: "outbox_events" }]);
      const write = await client.query(`SELECT has_table_privilege('cdc_reader',
        'public.outbox_events','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed`);
      assert.equal(write.rows[0].allowed, false);
      const publication =
        await client.query(`SELECT schemaname, tablename FROM pg_publication_tables
        WHERE pubname = 'greenguard_outbox'`);
      assert.deepEqual(publication.rows, [
        { schemaname: "public", tablename: "outbox_events" },
      ]);
      const forced =
        await client.query(`SELECT relrowsecurity AND relforcerowsecurity AS forced
        FROM pg_class WHERE oid = 'public.outbox_events'::regclass`);
      assert.equal(forced.rows[0].forced, true);
      const inserted: { rows: { event_id: string; tenant_id: string }[] } = {
        rows: [],
      };
      for (let i = 0; i < 2; i++) {
        const tenantId = randomUUID(),
          incarnation = randomUUID();
        await client.query(
          "INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,'s1',$2,1,'active')",
          [tenantId, incarnation],
        );
        await admitOwnerPlacement(
          tenantId,
          {
            tenantId,
            shardId: "s1",
            shardIncarnation: incarnation,
            placementEpoch: "1",
            state: "active",
            expiresAt: new Date(Date.now() + 1900).toISOString(),
          },
          (sql, params) => client.query(sql, params),
        );
        const result = await client.query(
          `INSERT INTO outbox_events
          (event_id, tenant_id, aggregate_type, aggregate_id, aggregate_version,
           event_type, schema_version, occurred_at, correlation_id, causation_id, traceparent, payload)
          VALUES(gen_random_uuid(), $1, 'device', gen_random_uuid(), 1,
           'device.registered', 1, clock_timestamp(), gen_random_uuid(), gen_random_uuid(), '', '{}') RETURNING event_id, tenant_id`,
          [tenantId],
        );
        inserted.rows.push(...result.rows);
      }
      await client.query("SET LOCAL ROLE cdc_reader");
      const rows = await client.query(
        "SELECT event_id, tenant_id FROM outbox_events WHERE event_id = ANY($1::uuid[]) ORDER BY event_id",
        [inserted.rows.map((row: { event_id: string }) => row.event_id)],
      );
      assert.equal(rows.rowCount, 2);
      assert.equal(
        new Set(rows.rows.map((row: { tenant_id: string }) => row.tenant_id))
          .size,
        2,
      );
      const forbidden = database === "inventory" ? "devices" : "readings";
      await assert.rejects(client.query(`SELECT * FROM ${forbidden}`), {
        code: "42501",
      });
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  }
});
