-- A binding.await command is acknowledged only after this service's local
-- binding has become active. The receipt/result is durable across restarts.
CREATE TABLE saga_binding_requests (
  tenant_id uuid NOT NULL,
  command_id uuid NOT NULL,
  saga_id uuid NOT NULL,
  device_id uuid NOT NULL,
  saga_version bigint NOT NULL CHECK (saga_version > 0),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  result_id uuid NOT NULL DEFAULT gen_random_uuid(),
  outcome text CHECK (outcome = 'succeeded'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  published_at timestamptz,
  PRIMARY KEY (tenant_id, command_id),
  CHECK ((outcome IS NULL AND completed_at IS NULL) OR
         (outcome = 'succeeded' AND completed_at IS NOT NULL))
);
CREATE INDEX saga_binding_pending_device ON saga_binding_requests (tenant_id, device_id)
  WHERE outcome IS NULL;
CREATE INDEX saga_binding_unpublished ON saga_binding_requests (created_at, command_id)
  WHERE outcome = 'succeeded' AND published_at IS NULL;
ALTER TABLE saga_binding_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE saga_binding_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saga_binding_requests
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON saga_binding_requests TO telemetry_app;
GRANT UPDATE (outcome, completed_at, published_at) ON saga_binding_requests TO telemetry_app;
