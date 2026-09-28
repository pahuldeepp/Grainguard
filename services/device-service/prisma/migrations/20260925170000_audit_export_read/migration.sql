-- The owner retains writes; the control plane reads through this tenant-scoped
-- runtime role with the existing FORCE RLS policy and app.tenant_id setting.
GRANT SELECT ON audit_events TO inventory_app;
CREATE INDEX audit_events_export_page ON audit_events
  (tenant_id, occurred_at, audit_id);
