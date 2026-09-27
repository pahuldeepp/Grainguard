-- A command is committed before Stripe is called. This unscoped index contains
-- only opaque IDs and lets a worker discover tenant-scoped commands after a crash.
-- The trigger runs in the same transaction as the command and its outbox row.
CREATE TABLE billing_inbox.command_work (
  tenant_id uuid NOT NULL,
  command_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','quarantined')),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, command_id)
);
CREATE INDEX command_work_pending ON billing_inbox.command_work (status, updated_at)
  WHERE status IN ('pending','running');

CREATE FUNCTION billing_inbox.queue_command() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = billing_inbox, public AS $$
BEGIN
  INSERT INTO billing_inbox.command_work (tenant_id, command_id)
  VALUES (NEW.tenant_id, NEW.command_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_command_work_after_insert AFTER INSERT ON billing_commands
  FOR EACH ROW EXECUTE FUNCTION billing_inbox.queue_command();

-- Existing pending commands survive a rollout that adds this migration later.
INSERT INTO billing_inbox.command_work (tenant_id, command_id, status)
SELECT tenant_id, command_id,
  CASE WHEN status='completed' THEN 'completed'
       WHEN status='quarantined' THEN 'quarantined' ELSE 'pending' END
FROM billing_commands ON CONFLICT DO NOTHING;

REVOKE ALL ON billing_inbox.command_work FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON billing_inbox.command_work TO billing_app;
