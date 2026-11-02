-- Preserve late anomaly audit without opening an episode for an earlier occupancy.
-- Forward-only: do not change the already-applied decision-table migration.
ALTER TABLE anomaly_decisions DROP CONSTRAINT anomaly_decisions_outcome_check;
ALTER TABLE anomaly_decisions ADD CONSTRAINT anomaly_decisions_outcome_check
  CHECK (outcome IN ('published', 'no_corroboration', 'not_higher', 'below_threshold',
    'too_old', 'device_unbound', 'device_not_active', 'binding_mismatch', 'superseded_lot'));
