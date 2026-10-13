-- Validate separately from the brief access-exclusive 000012 schema changes.
-- NOT VALID already enforces these physical constraints for all new rows.
SET lock_timeout = '5s';
ALTER TABLE readings VALIDATE CONSTRAINT readings_actual_measurement;
ALTER TABLE readings VALIDATE CONSTRAINT readings_co2_physical;
ALTER TABLE readings VALIDATE CONSTRAINT readings_grain_moisture_physical;
ALTER TABLE readings VALIDATE CONSTRAINT readings_sensor_observations_array;
RESET lock_timeout;
