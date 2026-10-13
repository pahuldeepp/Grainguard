-- Refuse destructive rollback when v2 readings exist; their immutable data is retained.
-- DDL constraint validation scans every row even under forced RLS. A SELECT
-- by the migrator would see no rows without tenant context and is unsafe here.
ALTER TABLE readings ADD CONSTRAINT telemetry_v2_rollback_guard CHECK (schema_version=1);
DROP TABLE cable_layout_bindings;
ALTER TABLE readings DROP CONSTRAINT readings_actual_measurement,
 DROP COLUMN co2_ppm, DROP COLUMN grain_moisture_percent, DROP COLUMN measurement_units,
 DROP COLUMN sensor_observations, DROP COLUMN schema_version;
ALTER TABLE readings ADD CONSTRAINT readings_check CHECK (temperature_c IS NOT NULL OR relative_humidity_percent IS NOT NULL);
