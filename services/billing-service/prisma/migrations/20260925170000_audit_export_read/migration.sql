GRANT SELECT ON billing_audit_events TO billing_app;
CREATE INDEX billing_audit_events_export_page ON billing_audit_events
  (tenant_id, occurred_at, audit_id);
