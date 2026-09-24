-- A lot belongs to a real tenant even before its first occupancy is inserted.
ALTER TABLE grain_lots ADD CONSTRAINT grain_lots_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;
