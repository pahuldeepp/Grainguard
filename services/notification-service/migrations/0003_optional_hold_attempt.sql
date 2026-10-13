-- Optional flag hold exhaustion is a ledger event, not a provider send attempt.
ALTER TABLE delivery_attempts DROP CONSTRAINT delivery_attempts_kind_check;
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempts_kind_check
  -- Preserve the historical spelling written by the earlier
  -- 0003_hold_expired_attempt migration while new code writes `hold`.
  CHECK (kind IN ('send', 'reconcile', 'preference', 'hold', 'hold_expired'));
