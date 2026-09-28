-- Optional flag hold exhaustion is a ledger event, not a provider send attempt.
ALTER TABLE delivery_attempts DROP CONSTRAINT delivery_attempts_kind_check;
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempts_kind_check
  CHECK (kind IN ('send', 'reconcile', 'preference', 'hold'));
