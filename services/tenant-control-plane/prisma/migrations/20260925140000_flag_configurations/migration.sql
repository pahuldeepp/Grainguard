-- Stage 09f: tenant flag snapshots. Every mutation appends one audit row and one
-- outbox event in the same transaction. Runtime role cannot alter either ledger.
CREATE TABLE flag_configurations (
  tenant_id uuid NOT NULL REFERENCES organizations(tenant_id) ON DELETE RESTRICT,
  config_id uuid NOT NULL,
  flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_version bigint NOT NULL DEFAULT 1 CHECK (config_version > 0),
  updated_by uuid NOT NULL REFERENCES identities(identity_id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id),
  UNIQUE (tenant_id, config_id),
  CHECK (jsonb_typeof(flags) = 'object')
);
CREATE TABLE flag_configuration_audit (
  tenant_id uuid NOT NULL,
  audit_id uuid NOT NULL,
  config_id uuid NOT NULL,
  config_version bigint NOT NULL,
  actor_identity_id uuid NOT NULL REFERENCES identities(identity_id),
  flags jsonb NOT NULL,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, audit_id),
  UNIQUE (tenant_id, config_id, config_version),
  FOREIGN KEY (tenant_id, config_id) REFERENCES flag_configurations(tenant_id, config_id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['flag_configurations','flag_configuration_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON flag_configurations, flag_configuration_audit TO control_app;
GRANT UPDATE (flags, config_version, updated_by, updated_at) ON flag_configurations TO control_app;
