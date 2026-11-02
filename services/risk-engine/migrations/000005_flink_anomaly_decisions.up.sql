-- ADR-0031: advisory Flink anomalies. Forward-only; runs as risk_migrator.
-- Concurrency: none beyond the primary key. One decision per anomaly event; the consumer
-- inbox and the per-device / per-bin locks in the apply transaction serialise the writers.
-- Insert-only for risk_app (no UPDATE, no DELETE), forced RLS like every tenant table.

ALTER TABLE risk_assessments
  ADD COLUMN source_kind text NOT NULL DEFAULT 'threshold' CHECK (source_kind IN ('threshold', 'anomaly'));

-- The anomaly policy reads the newest threshold assessment of one device and lot.
CREATE INDEX risk_assessments_device_lot_threshold_idx
  ON risk_assessments (tenant_id, device_id, lot_id, observed_at DESC) WHERE source_kind = 'threshold';

-- Audit of every anomaly the engine decided, published or not. Not an event source: only
-- published decisions have an assessment and an outbox row.
CREATE TABLE anomaly_decisions (
  tenant_id        uuid        NOT NULL,
  anomaly_event_id uuid        NOT NULL,
  device_id        uuid        NOT NULL,
  metric           text        NOT NULL CHECK (metric IN ('temperature_c', 'relative_humidity_percent')),
  detector         text        NOT NULL CHECK (detector IN ('zscore', 'rapid_change')),
  outcome          text        NOT NULL CHECK (outcome IN ('published', 'no_corroboration', 'not_higher',
                     'below_threshold', 'too_old', 'device_unbound', 'device_not_active', 'binding_mismatch')),
  base_score       smallint    CHECK (base_score BETWEEN 0 AND 100),
  points           smallint    CHECK (points BETWEEN 1 AND 75),
  combined_score   smallint    CHECK (combined_score BETWEEN 0 AND 100),
  assessment_id    uuid,
  observed_at      timestamptz NOT NULL,
  decided_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, anomaly_event_id),
  FOREIGN KEY (tenant_id, assessment_id) REFERENCES risk_assessments (tenant_id, assessment_id),
  CHECK ((outcome = 'published') = (assessment_id IS NOT NULL))
);

ALTER TABLE anomaly_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE anomaly_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON anomaly_decisions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON anomaly_decisions TO risk_app;
