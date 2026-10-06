import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";

const adminUrl = process.env.POSTGRES_ADMIN_URL;

test("audit reader can only select the forced-RLS billing audit table", async (t) => {
  if (!adminUrl || !process.env.BILLING_DATABASE_URL)
    return t.skip("POSTGRES_ADMIN_URL and BILLING_DATABASE_URL are required");
  const endpoint = new URL(adminUrl);
  endpoint.pathname = new URL(process.env.BILLING_DATABASE_URL).pathname;
  const client = new pg.Client({ connectionString: endpoint.toString() });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT has_table_privilege('billing_audit_reader','public.billing_audit_events','SELECT') AS can_read_audit,
              has_table_privilege('billing_audit_reader','public.billing_audit_events','INSERT') AS can_insert_audit,
              has_table_privilege('billing_audit_reader','public.subscriptions','SELECT') AS can_read_subscriptions,
              (SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolbypassrls FROM pg_roles WHERE rolname='billing_audit_reader') AS safe_role,
              (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles g ON g.oid=m.roleid WHERE r.rolname='billing_audit_reader' OR g.rolname='billing_audit_reader') AS role_memberships,
              (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.billing_audit_events'::regclass) AS forced_rls,
              (SELECT count(*)::int FROM pg_policies WHERE schemaname='public' AND tablename='billing_audit_events' AND policyname='tenant_isolation') AS tenant_policy`,
    );
    assert.deepEqual(result.rows[0], {
      can_read_audit: true,
      can_insert_audit: false,
      can_read_subscriptions: false,
      safe_role: true,
      role_memberships: 0,
      forced_rls: true,
      tenant_policy: 1,
    });
  } finally {
    await client.end();
  }
});
