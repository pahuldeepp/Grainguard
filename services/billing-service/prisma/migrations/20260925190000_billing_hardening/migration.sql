-- Stage 09d review fixes. Forward-only (review O5).

-- Stripe `paused` is stored as its own status (entitlement is kept, see webhooks.ts).
-- `incomplete_expired` is mapped to `canceled` by the port: it never held an entitlement.
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('incomplete','trialing','active','past_due','unpaid','canceled','paused'));

-- billing_inbox.due_work and billing_inbox.command_work are EXPLICIT cross-tenant work
-- queues, exempt from RLS on purpose: the worker must find due work across all tenants
-- without a tenant context, and a per-tenant policy would force a full scan per tenant.
-- They hold only opaque IDs and scheduling metadata (tenant_id, command_id, kind, due_at,
-- status, lease and attempt counters); every payload, plan and amount is read afterwards
-- inside that tenant's forced-RLS transaction. Rows are never deleted: a finished item
-- is marked done/completed, so billing_app loses DELETE (the repo's no-DELETE rule).
ALTER TABLE billing_inbox.due_work
  ADD COLUMN status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done'));
DROP INDEX billing_inbox.billing_due_work_ready;
CREATE INDEX billing_due_work_ready ON billing_inbox.due_work (due_at, tenant_id)
  WHERE status = 'pending';
REVOKE DELETE ON billing_inbox.due_work FROM billing_app;

-- Not-yet-due waits and retries back off through available_at instead of a fixed 1s poll.
ALTER TABLE billing_inbox.command_work
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp();
DROP INDEX billing_inbox.command_work_pending;
CREATE INDEX command_work_pending ON billing_inbox.command_work (available_at, updated_at)
  WHERE status IN ('pending','running');
REVOKE DELETE ON billing_inbox.command_work FROM billing_app;

-- Quarantined transient webhook failures are redriven by a bounded sweep (0..6 times).
ALTER TABLE billing_inbox.stripe_webhook_inbox
  ADD COLUMN auto_redrives integer NOT NULL DEFAULT 0 CHECK (auto_redrives >= 0);
CREATE INDEX stripe_webhook_quarantined ON billing_inbox.stripe_webhook_inbox (updated_at)
  WHERE status = 'quarantined';
