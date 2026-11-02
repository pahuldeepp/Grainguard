-- Terminal source identities prevent rejected telemetry from blocking an anomaly partition.
-- Insert-only, independent of consumer groups. Committed atomically with quarantine.
-- These are rejection evidence only: never corroboration or authority to publish.
CREATE TABLE rejected_telemetry_causes (
  tenant_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  device_id uuid NOT NULL,
  reading_id uuid NOT NULL,
  reason text NOT NULL,
  rejected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, source_event_id, device_id, reading_id)
);
ALTER TABLE rejected_telemetry_causes ENABLE ROW LEVEL SECURITY;
ALTER TABLE rejected_telemetry_causes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rejected_telemetry_causes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON rejected_telemetry_causes TO risk_app;
