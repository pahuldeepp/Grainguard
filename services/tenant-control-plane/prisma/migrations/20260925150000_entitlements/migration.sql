-- Local billing projection. The application can read, but only a projector may
-- apply newer versions. The organization row already serializes seat/key writes.
CREATE TABLE tenant_entitlements (
 tenant_id uuid PRIMARY KEY,
 plan_key text NOT NULL,
 plan_version bigint NOT NULL CHECK (plan_version > 0),
 limits jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
 features jsonb NOT NULL CHECK (jsonb_typeof(features) = 'object'),
 source_version bigint NOT NULL CHECK (source_version > 0),
 applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_entitlements
 USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
 WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON tenant_entitlements TO control_app;
GRANT USAGE ON SCHEMA public TO control_entitlement_projector;
GRANT SELECT, INSERT, UPDATE ON tenant_entitlements TO control_entitlement_projector;
