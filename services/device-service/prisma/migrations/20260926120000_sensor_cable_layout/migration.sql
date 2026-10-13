-- Device locks precede cable locks. All layout edits compare/increment version
-- and append an owner snapshot in the same transaction. Removed identities are
-- retained; position uniqueness only applies to current sensors.
CREATE TABLE bin_cables (
  tenant_id uuid NOT NULL,
  cable_id uuid NOT NULL,
  bin_id uuid NOT NULL,
  device_id uuid NOT NULL,
  label text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT bin_cables_pkey PRIMARY KEY (tenant_id, cable_id),
  CONSTRAINT bin_cables_tenant_id_bin_id_fkey FOREIGN KEY (tenant_id, bin_id) REFERENCES bins(tenant_id, bin_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT bin_cables_tenant_id_device_id_fkey FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, device_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT bin_cables_label_check CHECK (length(btrim(label)) BETWEEN 1 AND 200 AND length(label) <= 200),
  CONSTRAINT bin_cables_version_check CHECK (version > 0),
  CONSTRAINT bin_cables_status_check CHECK (status IN ('active', 'removed'))
);
CREATE INDEX bin_cables_tenant_id_bin_id_cable_id_idx ON bin_cables(tenant_id, bin_id, cable_id);
CREATE INDEX bin_cables_tenant_id_device_id_cable_id_idx ON bin_cables(tenant_id, device_id, cable_id);
CREATE TABLE cable_sensors (
  tenant_id uuid NOT NULL,
  sensor_id uuid NOT NULL,
  cable_id uuid NOT NULL,
  label text NOT NULL,
  position integer NOT NULL,
  depth_m double precision,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cable_sensors_pkey PRIMARY KEY (tenant_id, sensor_id),
  CONSTRAINT cable_sensors_tenant_id_cable_id_fkey FOREIGN KEY (tenant_id, cable_id) REFERENCES bin_cables(tenant_id, cable_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT cable_sensors_label_check CHECK (length(btrim(label)) BETWEEN 1 AND 200 AND length(label) <= 200),
  CONSTRAINT cable_sensors_position_check CHECK (position BETWEEN 1 AND 100),
  CONSTRAINT cable_sensors_depth_check CHECK (depth_m IS NULL OR (depth_m >= 0 AND depth_m < 'Infinity'::double precision)),
  CONSTRAINT cable_sensors_status_check CHECK (status IN ('active', 'removed'))
);
CREATE INDEX cable_sensors_tenant_id_cable_id_position_idx ON cable_sensors(tenant_id, cable_id, position);
CREATE UNIQUE INDEX cable_sensors_active_position_key ON cable_sensors(tenant_id, cable_id, position) WHERE status = 'active';
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bin_cables','cable_sensors'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON bin_cables, cable_sensors TO inventory_app;
GRANT UPDATE (bin_id, device_id, label, version, status, updated_at) ON bin_cables TO inventory_app;
GRANT UPDATE (label, position, depth_m, status) ON cable_sensors TO inventory_app;
