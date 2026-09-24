-- Append-only retractions for assessments invalidated by a backdated lot placement.
-- The risk_app role can insert but cannot update or delete these rows.
CREATE TABLE risk_assessment_invalidations (
  tenant_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  replacement_lot_id uuid NOT NULL,
  replacement_occupancy_version bigint NOT NULL CHECK (replacement_occupancy_version > 0),
  source_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, assessment_id),
  FOREIGN KEY (assessment_id) REFERENCES risk_assessments (assessment_id)
);
ALTER TABLE risk_assessment_invalidations ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_assessment_invalidations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON risk_assessment_invalidations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON risk_assessment_invalidations TO risk_app;
