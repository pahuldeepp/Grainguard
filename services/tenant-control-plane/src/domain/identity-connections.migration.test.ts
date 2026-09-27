import assert from "node:assert/strict";
import { test } from "node:test";
import { adminQuery } from "../testing/fixtures.js";

test("identity connection tables enforce tenant RLS and runtime has no delete", async () => {
  const tables = await adminQuery<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(`
    SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
     WHERE relname IN ('identity_connections', 'identity_connection_domains') ORDER BY relname`);
  assert.equal(tables.length, 2);
  for (const row of tables) {
    assert.equal(row.relrowsecurity, true, row.relname);
    assert.equal(row.relforcerowsecurity, true, row.relname);
  }
  const grants = await adminQuery<{ table_name: string }>(`
    SELECT table_name FROM information_schema.role_table_grants
     WHERE grantee = 'control_app' AND table_name IN ('identity_connections', 'identity_connection_domains')
       AND privilege_type IN ('DELETE', 'TRUNCATE')`);
  assert.deepEqual(grants, []);
});
