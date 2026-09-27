-- Monotonic local projection and transactional accepted-reading meter.
CREATE TABLE tenant_entitlements (
  tenant_id uuid PRIMARY KEY,
  plan_key text NOT NULL,
  plan_version bigint NOT NULL CHECK (plan_version > 0),
  limits jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
  features jsonb NOT NULL CHECK (jsonb_typeof(features) = 'object'),
  source_version bigint NOT NULL CHECK (source_version > 0),
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ingest_quota_usage (
  tenant_id uuid NOT NULL,
  period_start date NOT NULL,
  accepted bigint NOT NULL DEFAULT 0 CHECK (accepted >= 0),
  PRIMARY KEY (tenant_id, period_start)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_entitlements', 'ingest_quota_usage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
GRANT SELECT ON tenant_entitlements TO telemetry_app;
GRANT SELECT, INSERT, UPDATE (accepted) ON ingest_quota_usage TO telemetry_app;
GRANT USAGE ON SCHEMA public TO telemetry_entitlement_projector;
GRANT SELECT, INSERT, UPDATE ON tenant_entitlements TO telemetry_entitlement_projector;
