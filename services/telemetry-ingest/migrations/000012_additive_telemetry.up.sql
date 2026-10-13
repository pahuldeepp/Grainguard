-- ADR-0027: nullable independent metrics; v1 rows and receipts remain unchanged.
SET lock_timeout = '5s';
ALTER TABLE readings ADD COLUMN co2_ppm double precision,
 ADD COLUMN grain_moisture_percent double precision,
 ADD COLUMN measurement_units jsonb,
 ADD COLUMN sensor_observations jsonb NOT NULL DEFAULT '[]'::jsonb,
 ADD COLUMN schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version IN (1,2));
ALTER TABLE readings DROP CONSTRAINT readings_check;
ALTER TABLE readings ADD CONSTRAINT readings_actual_measurement CHECK (
 temperature_c IS NOT NULL OR relative_humidity_percent IS NOT NULL OR co2_ppm IS NOT NULL
 OR grain_moisture_percent IS NOT NULL OR jsonb_array_length(sensor_observations)>0) NOT VALID,
 ADD CONSTRAINT readings_co2_physical CHECK (co2_ppm IS NULL OR (co2_ppm >= 0 AND co2_ppm < 'Infinity'::double precision)) NOT VALID,
 ADD CONSTRAINT readings_grain_moisture_physical CHECK (grain_moisture_percent IS NULL OR grain_moisture_percent BETWEEN 0 AND 100) NOT VALID,
 ADD CONSTRAINT readings_sensor_observations_array CHECK (jsonb_typeof(sensor_observations)='array' AND jsonb_array_length(sensor_observations)<=256) NOT VALID;

-- Full owner snapshots, serialized by a per-tenant/cable advisory transaction lock.
-- Resolution takes a share lock, retaining association/layout as of ingestion.
-- No cross-service writes or inventory foreign keys. Explicit predicates + forced RLS.
CREATE TABLE cable_layout_bindings (
 tenant_id uuid NOT NULL, cable_id uuid NOT NULL,
 device_id uuid NOT NULL, bin_id uuid,
 layout_version bigint NOT NULL CHECK (layout_version>0),
 deleted boolean NOT NULL, sensors jsonb NOT NULL CHECK (jsonb_typeof(sensors)='array'),
 PRIMARY KEY (tenant_id,cable_id)
);
CREATE INDEX cable_layout_device_idx ON cable_layout_bindings(tenant_id,device_id);
ALTER TABLE cable_layout_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cable_layout_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cable_layout_bindings
 USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT, INSERT ON cable_layout_bindings TO telemetry_app;
GRANT UPDATE (device_id,bin_id,layout_version,deleted,sensors) ON cable_layout_bindings TO telemetry_app;

RESET lock_timeout;
