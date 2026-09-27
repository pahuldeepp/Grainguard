ALTER TABLE delivery_attempts
  DROP CONSTRAINT delivery_attempts_kind_check,
  ADD CONSTRAINT delivery_attempts_kind_check
    CHECK (kind IN ('send', 'reconcile', 'preference', 'hold_expired'));
