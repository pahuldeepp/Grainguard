import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { adminUrl, env } from "./testing/fixtures.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

function prisma(args: string[], migrationUrl: string) {
  return spawnSync("npx", ["prisma", ...args], {
    cwd: packageDir,
    env: { ...process.env, INVENTORY_MIGRATION_URL: migrationUrl },
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
    assert.equal(policies[0].n, 7);
  } finally {
    await admin("postgres", `DROP DATABASE ${scratch} WITH (FORCE)`);
  }
});
