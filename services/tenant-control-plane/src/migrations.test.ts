import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { adminQuery, asRuntime } from "./testing/fixtures.js";

const TENANT_TABLES = [
  "command_receipts",
  "invitations",
  "membership_events",
  "memberships",
  "notification_contacts",
  "organizations",
  "outbox_events",
];

test("every tenant table has tenant_id and forced RLS; identities is the one documented exception", async () => {
  const rows = await adminQuery<{
    relname: string;
    forced: boolean;
    enabled: boolean;
    owner: string;
  }>(
    `SELECT c.relname, c.relforcerowsecurity AS forced, c.relrowsecurity AS enabled,
            pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
        AND c.relname <> '_prisma_migrations' ORDER BY c.relname`,
  );
  for (const table of [...TENANT_TABLES, "identities"])
    assert.ok(
      rows.some((r) => r.relname === table),
      table,
    );
  for (const r of rows) {
    assert.equal(r.owner, "control_migrator", r.relname);
    if (r.relname === "identities") continue;
    assert.ok(r.forced && r.enabled, r.relname);
  }
  const cols = await adminQuery<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name`,
  );
  for (const table of TENANT_TABLES)
    assert.ok(
      cols.some((c) => c.table_name === table),
      table,
    );
});

test("notification contacts CDC is table-scoped, read-only, RLS-visible and published for inserts/updates", async () => {
  const [publication] = await adminQuery<{
    publication_name: string;
    pubinsert: boolean;
    pubupdate: boolean;
    pubdelete: boolean;
  }>(
    `SELECT p.pubname AS publication_name, p.pubinsert, p.pubupdate, p.pubdelete
       FROM pg_publication p WHERE p.pubname='greenguard_control_notification_contacts'`,
  );
  assert.deepEqual(publication, {
    publication_name: "greenguard_control_notification_contacts",
    pubinsert: true,
    pubupdate: true,
    pubdelete: false,
  });
  const [grant] = await adminQuery<{ has_select: boolean }>(
    `SELECT has_table_privilege('cdc_reader','public.notification_contacts','SELECT') AS has_select`,
  );
  assert.equal(grant?.has_select, true);
  const policy = await adminQuery<{ roles: string[]; qual: string }>(
    `SELECT roles::text[] AS roles, qual FROM pg_policies
      WHERE schemaname='public' AND tablename='notification_contacts'
        AND policyname='cdc_notification_contacts_snapshot'`,
  );
  assert.deepEqual(policy, [{ roles: ["cdc_reader"], qual: "true" }]);
});

test("notification contact migration keeps format checks and permits a versioned cleared row", async () => {
  const tenantId = randomUUID();
  const actorId = randomUUID();
  await organization(tenantId);
  await adminQuery(
    `INSERT INTO identities (identity_id, issuer, subject) VALUES ($1::uuid, 'https://cdc-test.invalid', $2)`,
    [actorId, actorId],
  );
  await asRuntime(
    { "app.tenant_id": tenantId },
    `INSERT INTO notification_contacts (tenant_id,email_to,sms_to,version,updated_by)
     VALUES ($1,'alerts@example.test','+12045550123',1,$2)`,
    [tenantId, actorId],
  );
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": tenantId },
      `UPDATE notification_contacts SET email_to='invalid' WHERE tenant_id=$1`,
      [tenantId],
    ),
    /check constraint/,
  );
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": tenantId },
      `UPDATE notification_contacts SET sms_to='12045550123' WHERE tenant_id=$1`,
      [tenantId],
    ),
    /check constraint/,
  );
  await asRuntime(
    { "app.tenant_id": tenantId },
    `UPDATE notification_contacts SET email_to=NULL,sms_to=NULL,version=2 WHERE tenant_id=$1`,
    [tenantId],
  );
  const rows = await asRuntime(
    { "app.tenant_id": tenantId },
    `SELECT email_to,sms_to,version FROM notification_contacts WHERE tenant_id=$1`,
    [tenantId],
  );
  assert.deepEqual(rows.rows, [{ email_to: null, sms_to: null, version: "2" }]);
});

test("M12: control_app has no DELETE anywhere and cannot UPDATE audit, outbox or receipts", async () => {
  const grants = await adminQuery<{
    table_name: string;
    privilege_type: string;
  }>(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'control_app' AND privilege_type IN ('DELETE', 'TRUNCATE', 'UPDATE')`,
  );
  assert.deepEqual(grants, []);
  const columns = await adminQuery<{ table_name: string }>(
    `SELECT DISTINCT table_name FROM information_schema.column_privileges
      WHERE grantee = 'control_app' AND privilege_type = 'UPDATE' ORDER BY table_name`,
  );
  for (const table of ["invitations", "memberships", "organizations"])
    assert.ok(
      columns.some((c) => c.table_name === table),
      table,
    );
  for (const table of [
    "membership_events",
    "command_receipts",
    "outbox_events",
  ])
    assert.ok(!columns.some((c) => c.table_name === table), table);
  const [role] = await adminQuery<{ rolbypassrls: boolean; rolsuper: boolean }>(
    "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'control_app'",
  );
  assert.deepEqual(role, { rolbypassrls: false, rolsuper: false });
  await assert.rejects(
    asRuntime({ "app.tenant_id": randomUUID() }, "DELETE FROM memberships"),
    /permission denied/,
  );
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": randomUUID() },
      "UPDATE membership_events SET action = 'x'",
    ),
    /permission denied/,
  );
});

async function organization(tenantId: string) {
  await asRuntime(
    { "app.tenant_id": tenantId },
    `INSERT INTO organizations (tenant_id, name, created_by) VALUES ($1, 'org', $2)`,
    [tenantId, randomUUID()],
  );
}

test("RLS: a tenant sees and writes only its own rows", async () => {
  const [a, b] = [randomUUID(), randomUUID()];
  await organization(a);
  await organization(b);
  const seenByB = await asRuntime(
    { "app.tenant_id": b },
    "SELECT tenant_id FROM organizations",
  );
  assert.deepEqual(seenByB.rows, [{ tenant_id: b }]);
  const none = await asRuntime({}, "SELECT tenant_id FROM organizations");
  assert.equal(none.rowCount, 0);
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": b },
      `INSERT INTO organizations (tenant_id, name, created_by) VALUES ($1, 'x', $1)`,
      [randomUUID()],
    ),
    /row-level security/,
  );
});

test("composite tenant keys and role checks are enforced by the database", async () => {
  const tenant = randomUUID();
  const identity = randomUUID();
  await adminQuery(
    `INSERT INTO identities (identity_id, issuer, subject) VALUES ($1, 'https://i', $2)`,
    [identity, identity],
  );
  const insertMember = (t: string, role: string) =>
    asRuntime(
      { "app.tenant_id": t },
      `INSERT INTO memberships (tenant_id, identity_id, role, granted_by) VALUES ($1, $2, $3, $2)`,
      [t, identity, role],
    );
  await assert.rejects(
    insertMember(tenant, "viewer"),
    /memberships_tenant_fkey/,
  );
  await organization(tenant);
  await assert.rejects(
    insertMember(tenant, "device"),
    /memberships_role_check/,
  );
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": tenant },
      `INSERT INTO memberships (tenant_id, identity_id, role, state, granted_by) VALUES ($1, $2, 'viewer', 'revoked', $2)`,
      [tenant, identity],
    ),
    /memberships_revoked_check/,
  );
  await insertMember(tenant, "viewer");
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": tenant },
      `INSERT INTO membership_events (tenant_id, audit_id, identity_id, action, actor_identity_id, correlation_id)
       VALUES ($1, gen_random_uuid(), $2, 'granted', $2, gen_random_uuid())`,
      [tenant, randomUUID()],
    ),
    /membership_events_member_fkey/,
  );
});
