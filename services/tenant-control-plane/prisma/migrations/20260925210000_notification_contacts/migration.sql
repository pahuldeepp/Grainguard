-- Stage 10d: trusted tenant-owned notification destinations. Values are only
-- returned to authenticated internal services; they never come from alert events.
-- Writes lock the organization and compare the expected contact version before
-- replacing destinations, including the first insert (expected version zero).
CREATE TABLE notification_contacts (
  tenant_id uuid PRIMARY KEY REFERENCES organizations(tenant_id) ON DELETE RESTRICT,
  email_to text,
  sms_to text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES identities(identity_id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (email_to IS NULL OR (length(email_to) BETWEEN 3 AND 320 AND email_to !~ '[[:cntrl:]<>;,"]' AND email_to ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  CHECK (sms_to IS NULL OR sms_to ~ '^\+[1-9][0-9]{7,14}$'),
  CHECK (email_to IS NOT NULL OR sms_to IS NOT NULL)
);
ALTER TABLE notification_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_contacts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON notification_contacts TO control_app;
GRANT UPDATE (email_to, sms_to, version, updated_by, updated_at)
  ON notification_contacts TO control_app;
