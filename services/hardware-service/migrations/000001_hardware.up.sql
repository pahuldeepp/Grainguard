-- Owned physical hardware registry. Row locks serialize claims and configuration.
CREATE TABLE hardware_assets (
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  serial_number text NOT NULL,
  state text NOT NULL DEFAULT 'available' CHECK (state IN ('available','reserved','configured')),
  owner_saga_id uuid,
  device_id uuid,
  fencing_token bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,asset_id),
  UNIQUE (tenant_id,serial_number),
  CHECK ((state='available' AND owner_saga_id IS NULL AND device_id IS NULL) OR
         (state<>'available' AND owner_saga_id IS NOT NULL AND device_id IS NOT NULL))
);

CREATE TABLE hardware_command_receipts (
  tenant_id uuid NOT NULL,
  command_id uuid NOT NULL,
  saga_id uuid NOT NULL,
  step text NOT NULL CHECK (step IN ('asset.reserve','asset.configure','asset.release')),
  saga_version bigint NOT NULL,
  fencing_token bigint NOT NULL,
  request_hash bytea NOT NULL,
  result_id uuid NOT NULL DEFAULT gen_random_uuid(),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,command_id),
  UNIQUE (tenant_id,result_id)
);

CREATE TABLE hardware_result_outbox (
  tenant_id uuid NOT NULL,
  result_id uuid NOT NULL,
  command_id uuid NOT NULL,
  saga_id uuid NOT NULL,
  step text NOT NULL,
  saga_version bigint NOT NULL,
  fencing_token bigint NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (tenant_id,result_id),
  FOREIGN KEY (tenant_id,command_id) REFERENCES hardware_command_receipts (tenant_id,command_id)
);
CREATE INDEX hardware_result_pending ON hardware_result_outbox (created_at,result_id) WHERE published_at IS NULL;

ALTER TABLE hardware_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE hardware_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_command_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE hardware_result_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_result_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON hardware_assets USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_isolation ON hardware_command_receipts USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_isolation ON hardware_result_outbox USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON hardware_assets TO hardware_app;
GRANT SELECT,INSERT ON hardware_command_receipts TO hardware_app;
GRANT SELECT,INSERT,UPDATE ON hardware_result_outbox TO hardware_app;
