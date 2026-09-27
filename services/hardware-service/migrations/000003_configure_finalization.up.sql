-- A released asset can no longer be configured, so its outstanding configure
-- receipt is finalized as 'cancelled' in the release transaction. No result is
-- published for it: the saga already superseded that step when it compensated.
ALTER TABLE hardware_command_receipts DROP CONSTRAINT hardware_command_receipts_outcome_check;
ALTER TABLE hardware_command_receipts ADD CONSTRAINT hardware_command_receipts_outcome_check
  CHECK (outcome IN ('pending','succeeded','rejected','cancelled'));

-- Fair dispatch: a claimed configuration moves to the back of the queue, so a
-- blocked receipt cannot keep a newer one out of the bounded batch.
-- Concurrency choice (ADR-0002): the dispatcher claims each receipt with
-- SELECT ... FOR UPDATE SKIP LOCKED inside the tenant transaction (pessimistic,
-- non-blocking); replicas skip rows another replica is claiming.
ALTER TABLE hardware_command_receipts ADD COLUMN last_dispatched_at timestamptz;
CREATE INDEX hardware_configure_dispatch ON hardware_command_receipts
  (last_dispatched_at NULLS FIRST, created_at, tenant_id, command_id)
  WHERE step='asset.configure' AND outcome='pending';

-- Repair receipts orphaned before this fix: pending configure receipts whose
-- asset is no longer reserved by the same saga.
UPDATE hardware_command_receipts r SET outcome='cancelled'
WHERE r.step='asset.configure' AND r.outcome='pending' AND NOT EXISTS (
  SELECT 1 FROM hardware_assets a
  WHERE a.tenant_id=r.tenant_id AND a.asset_id::text=r.request_payload->'payload'->>'asset_id'
    AND a.owner_saga_id=r.saga_id AND a.state='reserved');

DROP FUNCTION hardware_pending_configuration_ids();
-- ID-only selector: returns tenant and command identifiers, never payloads.
-- The batch is clamped to 1..100.
CREATE FUNCTION hardware_pending_configuration_ids(p_limit integer)
RETURNS TABLE(tenant_id uuid, command_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT r.tenant_id,r.command_id FROM hardware_command_receipts r
  WHERE r.step='asset.configure' AND r.outcome='pending'
  ORDER BY r.last_dispatched_at NULLS FIRST, r.created_at, r.tenant_id, r.command_id
  LIMIT LEAST(GREATEST(COALESCE(p_limit,100),1),100);
$$;
REVOKE ALL ON FUNCTION hardware_pending_configuration_ids(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hardware_pending_configuration_ids(integer) TO hardware_app;
