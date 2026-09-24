-- An operator redrive advances the generation of one logical intent. A prior sent result
-- remains terminal/idempotent; prior failed, suppressed, or dead results may be retried.
-- The trigger permits only the explicit generation-reset transition, preserving the
-- terminal guard for all ordinary updates.
ALTER TABLE deliveries ADD COLUMN delivery_generation integer NOT NULL DEFAULT 0 CHECK (delivery_generation >= 0);
ALTER TABLE delivery_attempts ADD COLUMN delivery_generation integer NOT NULL DEFAULT 0 CHECK (delivery_generation >= 0);

CREATE OR REPLACE FUNCTION deliveries_terminal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('sent', 'failed', 'suppressed') THEN
    IF OLD.status IN ('failed', 'suppressed')
       AND NEW.delivery_generation > OLD.delivery_generation
       AND NEW.status = 'received' AND NEW.attempts = 0 AND NEW.reconciles = 0
       AND NEW.provider_ref IS NULL AND NEW.last_error IS NULL AND NEW.terminal_at IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'delivery % already has terminal result %', OLD.intent_id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
