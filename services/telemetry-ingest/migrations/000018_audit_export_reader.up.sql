-- Audit exports use a separate read-only shard identity. Each page still sets
-- tenant/shard/incarnation/epoch and invokes physical placement admission.
GRANT USAGE ON SCHEMA public TO inventory_audit_reader;
GRANT USAGE ON SCHEMA greenguard_internal TO inventory_audit_reader;
GRANT SELECT ON audit_events TO inventory_audit_reader;
GRANT EXECUTE ON FUNCTION greenguard_internal.admit_tenant_placement(uuid,text,uuid,bigint)
  TO inventory_audit_reader;
