-- Enforce tenant identity at the foreign-key boundary, including privileged writes.
-- This is forward-only because 000002 may already be applied in local environments.
ALTER TABLE risk_assessments
  ADD CONSTRAINT risk_assessments_tenant_assessment_unique UNIQUE (tenant_id, assessment_id);
ALTER TABLE risk_assessment_invalidations
  DROP CONSTRAINT risk_assessment_invalidations_assessment_id_fkey;
ALTER TABLE risk_assessment_invalidations
  ADD CONSTRAINT risk_assessment_invalidations_tenant_assessment_fkey
  FOREIGN KEY (tenant_id, assessment_id)
  REFERENCES risk_assessments (tenant_id, assessment_id);
