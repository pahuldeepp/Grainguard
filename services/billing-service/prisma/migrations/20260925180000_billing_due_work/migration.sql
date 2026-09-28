-- Due work is indexed outside RLS and maintained in the same transaction as
-- each tenant subscription/usage mutation. The worker never scans all tenants.
CREATE TABLE billing_inbox.due_work (
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('subscription','usage')),
  due_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, kind)
);
CREATE INDEX billing_due_work_ready ON billing_inbox.due_work (due_at, tenant_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_inbox.due_work TO billing_app;
