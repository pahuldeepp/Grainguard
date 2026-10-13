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

test("audit exporter control role has only tenant-scoped read and job-state privileges", async () => {
  const [privileges] = await adminQuery<{
    can_read_membership: boolean;
    can_read_jobs: boolean;
    can_insert_jobs: boolean;
    can_update_state: boolean;
    can_update_requester: boolean;
    can_read_actions: boolean;
    can_insert_actions: boolean;
    can_claim: boolean;
    safe_role: boolean;
    role_memberships: number;
    jobs_rls: boolean;
    actions_rls: boolean;
  }>(
    `SELECT has_table_privilege('control_audit_worker','public.membership_events','SELECT') AS can_read_membership,
            has_table_privilege('control_audit_worker','public.audit_export_jobs','SELECT') AS can_read_jobs,
            has_table_privilege('control_audit_worker','public.audit_export_jobs','INSERT') AS can_insert_jobs,
            has_column_privilege('control_audit_worker','public.audit_export_jobs','state','UPDATE') AS can_update_state,
            has_column_privilege('control_audit_worker','public.audit_export_jobs','requester_id','UPDATE') AS can_update_requester,
            has_table_privilege('control_audit_worker','public.audit_export_actions','SELECT') AS can_read_actions,
            has_table_privilege('control_audit_worker','public.audit_export_actions','INSERT') AS can_insert_actions,
            has_function_privilege('control_audit_worker','public.claim_audit_export_job()','EXECUTE') AS can_claim,
            (SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolbypassrls FROM pg_roles WHERE rolname='control_audit_worker') AS safe_role,
            (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid WHERE r.rolname='control_audit_worker' OR g.rolname='control_audit_worker') AS role_memberships,
            (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.audit_export_jobs'::regclass) AS jobs_rls,
            (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.audit_export_actions'::regclass) AS actions_rls`,
  );
  assert.deepEqual(privileges, {
    can_read_membership: true,
    can_read_jobs: true,
    can_insert_jobs: false,
    can_update_state: true,
    can_update_requester: false,
    can_read_actions: true,
    can_insert_actions: false,
    can_claim: true,
    safe_role: true,
    role_memberships: 0,
    jobs_rls: true,
    actions_rls: true,
  });
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

test("M12: only ephemeral read leases permit DELETE; audit, outbox and receipts remain immutable", async () => {
  const grants = await adminQuery<{
    table_schema: string;
    table_name: string;
    privilege_type: string;
  }>(
    `SELECT table_schema, table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'control_app' AND privilege_type IN ('DELETE', 'TRUNCATE', 'UPDATE')
      ORDER BY table_schema, table_name, privilege_type`,
  );
  // Leases are ephemeral admission capabilities; releasing them requires DELETE.
  // The exact allowlist still rejects DELETE/TRUNCATE/table UPDATE elsewhere.
  assert.deepEqual(grants, [
    {
      table_schema: "public",
      table_name: "placement_read_leases",
      privilege_type: "DELETE",
    },
  ]);
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
