-- Match Prisma's stable compound-foreign-key names without changing the
-- already-applied grain-lot migration checksum.
ALTER TABLE bin_occupancies RENAME CONSTRAINT bin_occupancies_bin_fkey
  TO bin_occupancies_tenant_id_bin_id_fkey;
ALTER TABLE bin_occupancies RENAME CONSTRAINT bin_occupancies_lot_fkey
  TO bin_occupancies_tenant_id_lot_id_fkey;
