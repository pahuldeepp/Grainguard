-- One lot can occupy one bin once. Bin occupancy intervals never overlap;
-- command mutations serialize on the parent bin row and insert a monotone
-- occupancy version. The exclusion constraint protects the invariant even
-- if a future writer bypasses the command path.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE grain_lots (
  tenant_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  grain_type text NOT NULL,
  variety text,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT grain_lots_pkey PRIMARY KEY (tenant_id, lot_id),
  CONSTRAINT grain_lots_grain_type_check CHECK (grain_type ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT grain_lots_variety_check CHECK (variety IS NULL OR length(variety) BETWEEN 1 AND 100)
);

CREATE TABLE bin_occupancies (
  tenant_id uuid NOT NULL,
  bin_id uuid NOT NULL,
  occupancy_version bigint NOT NULL,
  lot_id uuid NOT NULL,
  effective_from timestamptz(6) NOT NULL,
  effective_to timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT bin_occupancies_pkey PRIMARY KEY (tenant_id, bin_id, occupancy_version),
  CONSTRAINT bin_occupancies_tenant_id_lot_id_key UNIQUE (tenant_id, lot_id),
  CONSTRAINT bin_occupancies_version_check CHECK (occupancy_version > 0),
  CONSTRAINT bin_occupancies_interval_check CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT bin_occupancies_bin_fkey FOREIGN KEY (tenant_id, bin_id) REFERENCES bins(tenant_id, bin_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT bin_occupancies_lot_fkey FOREIGN KEY (tenant_id, lot_id) REFERENCES grain_lots(tenant_id, lot_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT bin_occupancies_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, bin_id WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  )
);
CREATE INDEX bin_occupancies_tenant_id_bin_id_effective_from_idx
  ON bin_occupancies(tenant_id, bin_id, effective_from);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['grain_lots','bin_occupancies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON grain_lots, bin_occupancies TO inventory_app;
GRANT UPDATE (effective_to) ON bin_occupancies TO inventory_app;
