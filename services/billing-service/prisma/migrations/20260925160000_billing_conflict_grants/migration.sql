-- INSERT ... ON CONFLICT DO NOTHING checks its arbiter under SELECT privilege.
-- Tenant RLS still applies; the runtime role cannot update or delete either log.
GRANT SELECT ON billing_audit_events, outbox_events TO billing_app;
