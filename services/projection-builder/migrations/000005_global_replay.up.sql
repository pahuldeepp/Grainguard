-- Global replay records only tenant identities, not projection data. The reserved
-- infrastructure tenant is the sole RLS context allowed to read or write them.
-- The unique key makes retries idempotent; no mutable contention is introduced.
CREATE TABLE projection_replay_tenants (
 tenant_id uuid NOT NULL CHECK (tenant_id = '00000000-0000-4000-8000-000000000001'::uuid),
 event_tenant uuid NOT NULL CHECK (event_tenant <> tenant_id),
 PRIMARY KEY (tenant_id,event_tenant));
ALTER TABLE projection_replay_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE projection_replay_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON projection_replay_tenants
 USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON projection_replay_tenants TO projection_app;
