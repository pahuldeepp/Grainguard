-- Runtime may append independently verified move evidence, but cannot rewrite
-- or remove a receipt after it has been recorded. Privileged recovery remains
-- an operator/migration path and must be separately audited.
CREATE FUNCTION enforce_placement_receipt_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior record;
BEGIN
  IF current_user = 'control_app' THEN
    FOR prior IN SELECT key, value FROM jsonb_each(OLD.receipts)
    LOOP
      IF NOT (NEW.receipts ? prior.key)
         OR NEW.receipts->prior.key IS DISTINCT FROM prior.value THEN
        RAISE EXCEPTION 'placement move receipts are append-only'
          USING ERRCODE='insufficient_privilege';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enforce_placement_receipt_append_only() FROM PUBLIC;

CREATE TRIGGER placement_receipts_append_only
  BEFORE UPDATE OF receipts ON placement_moves
  FOR EACH ROW EXECUTE FUNCTION enforce_placement_receipt_append_only();
