-- The reserved infrastructure tenant holds global flags because the existing
-- outbox requires a non-null tenant_id. It is never a customer organization.
SELECT set_config('app.tenant_id', '00000000-0000-4000-8000-000000000001', false);
INSERT INTO identities (identity_id, issuer, subject)
VALUES ('00000000-0000-4000-8000-000000000002', 'urn:greenguard:system', 'flag-infrastructure')
ON CONFLICT DO NOTHING;
INSERT INTO organizations (tenant_id, name, state, created_by)
VALUES ('00000000-0000-4000-8000-000000000001', 'GreenGuard infrastructure', 'active', '00000000-0000-4000-8000-000000000002')
ON CONFLICT DO NOTHING;
SELECT set_config('app.tenant_id', '', false);
