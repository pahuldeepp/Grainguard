-- Bounded sample of refused readings for diagnosis. The primary key holds at most 20 slots
-- per device, so storage cannot grow with the number of rejected requests. Only a digest of
-- the payload is kept, never the payload itself.

CREATE TABLE ingest_rejection_samples (
  tenant_id      uuid        NOT NULL,
  device_id      uuid        NOT NULL,
  slot           smallint    NOT NULL CHECK (slot BETWEEN 0 AND 19),
  reason         text        NOT NULL,
  payload_sha256 text        NOT NULL,
  rejected_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, slot)
);

ALTER TABLE ingest_rejection_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_rejection_samples FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ingest_rejection_samples
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Overwrite-only: no DELETE, and the slot identity is never updatable.
GRANT SELECT, INSERT ON ingest_rejection_samples TO telemetry_app;
GRANT UPDATE (reason, payload_sha256, rejected_at) ON ingest_rejection_samples TO telemetry_app;
