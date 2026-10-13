ALTER TABLE action_proposals
  DROP COLUMN IF EXISTS execution_claimed_at,
  DROP COLUMN IF EXISTS execution_idempotency_key,
  DROP COLUMN IF EXISTS execution_receipt,
  DROP COLUMN IF EXISTS execution_error,
  DROP COLUMN IF EXISTS executed_at,
  DROP COLUMN IF EXISTS execution_attempts,
  DROP COLUMN IF EXISTS execution_status;

ALTER TABLE advisor_security_audit
  DROP CONSTRAINT IF EXISTS advisor_security_audit_kind_check;
ALTER TABLE advisor_security_audit
  ADD CONSTRAINT advisor_security_audit_kind_check
    CHECK (kind IN ('proposed','approved','rejected','expired','tool_allowed','tool_denied'));
