-- Durable execution state for an already approved action. The owner call is
-- always made outside a database transaction; these fields provide a bounded
-- claim/retry protocol and a deterministic idempotency key.
ALTER TABLE action_proposals
  ADD COLUMN IF NOT EXISTS execution_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (execution_status IN ('pending','running','retryable','succeeded','failed','not_applicable')),
  ADD COLUMN IF NOT EXISTS execution_attempts integer NOT NULL DEFAULT 0
    CHECK (execution_attempts >= 0 AND execution_attempts <= 8),
  ADD COLUMN IF NOT EXISTS execution_idempotency_key uuid,
  ADD COLUMN IF NOT EXISTS execution_receipt jsonb,
  ADD COLUMN IF NOT EXISTS execution_error text,
  ADD COLUMN IF NOT EXISTS executed_at timestamptz;

ALTER TABLE advisor_security_audit
  DROP CONSTRAINT IF EXISTS advisor_security_audit_kind_check;
ALTER TABLE advisor_security_audit
  ADD CONSTRAINT advisor_security_audit_kind_check
    CHECK (kind IN ('proposed','approved','rejected','expired','tool_allowed','tool_denied',
                    'execution_started','executed','execution_failed'));

GRANT UPDATE(execution_status,execution_attempts,execution_idempotency_key,
             execution_receipt,execution_error,executed_at)
  ON action_proposals TO advisor_app;
