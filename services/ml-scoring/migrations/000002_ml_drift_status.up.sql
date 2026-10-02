-- Durable aggregate drift snapshots. This stores PSI/count summaries only;
-- no sensor measurements or tenant identifiers enter telemetry labels.
CREATE TABLE ml_drift_status (
    tenant_id uuid NOT NULL,
    model_name text NOT NULL CHECK (length(model_name) BETWEEN 1 AND 128),
    model_version text NOT NULL CHECK (length(model_version) BETWEEN 1 AND 128),
    feature_name text NOT NULL CHECK (feature_name IN ('temperature_c', 'relative_humidity_percent')),
    psi double precision NOT NULL CHECK (psi >= 0 AND psi < 'Infinity'::double precision),
    sample_count integer NOT NULL CHECK (sample_count BETWEEN 1 AND 100000),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, model_name, model_version, feature_name)
);

ALTER TABLE ml_drift_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_drift_status FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ml_drift_status
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE ml_drift_status IS 'Latest per-tenant/model/feature PSI aggregate only; raw sensor measurements are never stored here.';
