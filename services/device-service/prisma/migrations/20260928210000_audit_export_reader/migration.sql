-- Tenant-control-plane reads inventory audit events only. Keep the API's
-- cross-owner audit source on its dedicated read-only shard identity rather
-- than the inventory_app writer role.
GRANT USAGE ON SCHEMA public, greenguard_internal TO inventory_audit_reader;
GRANT SELECT ON public.audit_events TO inventory_audit_reader;
GRANT EXECUTE ON FUNCTION greenguard_internal.admit_tenant_placement(uuid, text, uuid, bigint)
  TO inventory_audit_reader;
