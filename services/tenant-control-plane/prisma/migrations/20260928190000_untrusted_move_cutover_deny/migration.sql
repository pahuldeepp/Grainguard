-- There is no trusted all-owner mover yet. control_app may create a durable
-- preparation/quiesce record to stop new requests, but must not assert owner
-- evidence, switch placement, complete/abort a move, or advance the epoch.
REVOKE UPDATE (receipts, resulting_epoch) ON placement_moves FROM control_app;
REVOKE UPDATE (shard_id, routing_epoch) ON organizations FROM control_app;

CREATE FUNCTION enforce_control_app_move_boundary()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'control_app' AND (
    NEW.receipts IS DISTINCT FROM OLD.receipts OR
    NEW.resulting_epoch IS DISTINCT FROM OLD.resulting_epoch OR
    (NEW.state IS DISTINCT FROM OLD.state AND NOT
      (OLD.state = 'preparing' AND NEW.state = 'quiescing'))
  ) THEN
    RAISE EXCEPTION 'trusted all-owner mover required for receipt or cutover mutation'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enforce_control_app_move_boundary() FROM PUBLIC;
CREATE TRIGGER placement_moves_control_app_boundary
  BEFORE UPDATE ON placement_moves
  FOR EACH ROW EXECUTE FUNCTION enforce_control_app_move_boundary();

CREATE FUNCTION enforce_control_app_placement_boundary()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'control_app' AND (
    NEW.shard_id IS DISTINCT FROM OLD.shard_id OR
    NEW.routing_epoch IS DISTINCT FROM OLD.routing_epoch OR
    (NEW.placement_state IS DISTINCT FROM OLD.placement_state AND NOT
      (OLD.placement_state = 'active' AND NEW.placement_state = 'quiescing'))
  ) THEN
    RAISE EXCEPTION 'trusted all-owner mover required for placement activation or epoch change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enforce_control_app_placement_boundary() FROM PUBLIC;
CREATE TRIGGER organizations_control_app_placement_boundary
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION enforce_control_app_placement_boundary();
