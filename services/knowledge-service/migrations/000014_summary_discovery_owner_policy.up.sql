-- FORCE RLS also applies to the non-superuser migrator that owns discovery.
-- Permit that trusted, non-runtime function owner to discover tenant scopes.
-- knowledge_app keeps only principal_isolation; it can execute the narrow UUID
-- discovery function but cannot use this policy to read another user's payload.
DO $$
DECLARE discovery_owner name;
BEGIN
 SELECT r.rolname INTO discovery_owner FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid='knowledge_summary_pending_principals(uuid)'::regprocedure;
 IF discovery_owner IS NULL OR discovery_owner='knowledge_app' THEN
  RAISE EXCEPTION 'summary discovery requires a trusted non-runtime migration owner';
 END IF;
 EXECUTE format('CREATE POLICY summary_discovery_owner ON assistant_summary_jobs FOR SELECT TO %I USING(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',discovery_owner);
END $$;
