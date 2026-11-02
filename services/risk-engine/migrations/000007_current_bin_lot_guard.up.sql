-- Forward-only: keep the anomaly publication guard proportional to active bin
-- devices rather than assessment history. Deployment requires an index-build
-- maintenance window, as with 000006. Scoring still serializes under lock_bin;
-- the downstream advisory guard protects against cross-device Kafka reordering.
CREATE INDEX device_bindings_active_bin_idx
  ON device_bindings (tenant_id, bin_id, device_id) WHERE status = 'active';
CREATE INDEX risk_assessments_bin_lot_publication_idx
  ON risk_assessments (tenant_id, bin_id, lot_id, device_id, aggregate_version DESC);
