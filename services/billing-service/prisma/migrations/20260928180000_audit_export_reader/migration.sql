-- The audit exporter sees only tenant-scoped audit events, never billing state.
GRANT SELECT ON billing_audit_events TO billing_audit_reader;
