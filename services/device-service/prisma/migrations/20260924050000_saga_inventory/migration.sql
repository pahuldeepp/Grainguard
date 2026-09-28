-- Pending inventory devices have no published device.registered event. Only a
-- successful saga activation emits that established active-device contract.
ALTER TABLE devices ADD COLUMN asset_id uuid;
ALTER TABLE devices DROP CONSTRAINT devices_status_check;
ALTER TABLE devices ADD CONSTRAINT devices_status_check
  CHECK (status IN ('provisioning', 'active', 'disabled', 'deleted'));
CREATE UNIQUE INDEX devices_tenant_asset_claim ON devices(tenant_id, asset_id)
  WHERE asset_id IS NOT NULL AND status <> 'deleted';

CREATE TABLE inventory_saga_receipts (
  tenant_id uuid NOT NULL,
  command_id uuid NOT NULL,
  saga_id uuid NOT NULL,
  device_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  step text NOT NULL CHECK (step IN ('inventory.activate', 'inventory.deactivate')),
  saga_version bigint NOT NULL CHECK (saga_version > 0),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'rejected')),
  result_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, command_id)
);
CREATE TABLE inventory_saga_result_outbox (
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
  PRIMARY KEY (tenant_id, result_id),
  FOREIGN KEY (tenant_id, command_id) REFERENCES inventory_saga_receipts(tenant_id, command_id)
);
CREATE INDEX inventory_saga_result_pending ON inventory_saga_result_outbox(tenant_id, created_at, result_id)
  WHERE published_at IS NULL;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_saga_receipts', 'inventory_saga_result_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON inventory_saga_receipts TO inventory_app;
GRANT SELECT, INSERT, UPDATE(published_at) ON inventory_saga_result_outbox TO inventory_app;
