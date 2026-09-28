-- Read API's own local entitlement projection; billing lifecycle consumer writes
-- only higher source versions. The query role has no write privilege.
CREATE TABLE read.tenant_entitlements (
 tenant_id uuid PRIMARY KEY,
 plan_key text NOT NULL,
 plan_version bigint NOT NULL CHECK (plan_version > 0),
 limits jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
 features jsonb NOT NULL CHECK (jsonb_typeof(features) = 'object'),
 source_version bigint NOT NULL CHECK (source_version > 0),
 applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE read.tenant_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE read.tenant_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON read.tenant_entitlements
 USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
 WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON read.tenant_entitlements TO read_query;
GRANT USAGE ON SCHEMA read TO read_entitlement_projector;
GRANT SELECT, INSERT, UPDATE ON read.tenant_entitlements TO read_entitlement_projector;
