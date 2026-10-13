-- Tenant-owned immutable policies. A policy row is one immutable version and one
-- effective interval; changing it means appending a new version. Concurrent writers
-- serialize on (tenant, grain, bin scope) advisory locks in the policy repository.
CREATE TABLE grain_policies (
  tenant_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  grain_type text NOT NULL CHECK (grain_type ~ '^[a-z][a-z0-9_-]{0,31}$'),
  bin_id uuid,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  measurement_thresholds jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(measurement_thresholds) = 'object'),
  risk_thresholds jsonb NOT NULL
    CHECK (jsonb_typeof(risk_thresholds) = 'object'),
  calibrated boolean NOT NULL DEFAULT false,
  policy_status text NOT NULL CHECK (policy_status IN ('draft', 'active')),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  calibration_evidence text,
  approved_by text,
  approved_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, policy_id, policy_version),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (NOT calibrated OR (calibration_evidence IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (policy_status <> 'active' OR calibrated),
  UNIQUE (tenant_id, grain_type, bin_id, policy_id, policy_version)
);
ALTER TABLE grain_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE grain_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON grain_policies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- PostgreSQL's exclusion semantics treat NULL scopes as distinct; use a zero UUID
-- sentinel in the expression so grain-wide policies also cannot overlap each other.
ALTER TABLE grain_policies ADD CONSTRAINT grain_policies_no_active_overlap
  EXCLUDE USING gist (tenant_id WITH =, grain_type WITH =,
    (COALESCE(bin_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&)
  WHERE (policy_status = 'active');
CREATE INDEX grain_policies_select_idx ON grain_policies
  (tenant_id, grain_type, bin_id, effective_from DESC, policy_version DESC)
  WHERE policy_status = 'active';

CREATE FUNCTION grain_policies_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL
     AND (to_jsonb(NEW) - 'effective_to' - 'created_at')
         = (to_jsonb(OLD) - 'effective_to' - 'created_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'grain policy versions are immutable; append a new version'
    USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER grain_policies_immutable BEFORE UPDATE OR DELETE ON grain_policies
  FOR EACH ROW EXECUTE FUNCTION grain_policies_immutable();

-- Policy owner event is in the same transaction as the immutable policy version.
GRANT SELECT, INSERT ON grain_policies TO risk_app;

ALTER TABLE risk_assessments ADD COLUMN policy_id uuid;
ALTER TABLE risk_assessments ADD COLUMN policy_calibrated boolean NOT NULL DEFAULT false;
ALTER TABLE risk_assessments ADD COLUMN policy_provenance jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(policy_provenance) = 'object');
ALTER TABLE risk_assessments ADD CONSTRAINT risk_assessments_policy_fk
  FOREIGN KEY (tenant_id, policy_id, policy_version)
  REFERENCES grain_policies (tenant_id, policy_id, policy_version);
DO $$
DECLARE old_key text;
BEGIN
  SELECT conname INTO old_key FROM pg_constraint
   WHERE conrelid = 'risk_assessments'::regclass AND contype = 'u'
     AND pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, source_event_id, lot_id, policy_version)';
  IF old_key IS NULL THEN RAISE EXCEPTION 'expected legacy risk assessment identity constraint is missing'; END IF;
  EXECUTE format('ALTER TABLE risk_assessments DROP CONSTRAINT %I', old_key);
END $$;
ALTER TABLE risk_assessments ADD CONSTRAINT risk_assessments_policy_identity_unique
  UNIQUE (tenant_id, source_event_id, lot_id, policy_id, policy_version);
GRANT UPDATE (effective_to) ON grain_policies TO risk_app;
