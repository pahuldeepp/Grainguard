-- Stage 07: the inventory saga worker no longer takes a configured tenant list.
-- It asks this fixed SECURITY DEFINER selector which tenants have unpublished
-- results. The selector returns tenant IDs only, never row data; the worker then
-- reads and publishes each tenant's rows inside that tenant's RLS transaction.
-- Keyset pagination (p_after) lets the worker walk tenants round-robin, and the
-- batch is clamped to 1..100 so one pass is bounded.
-- FORCE RLS applies to the owner as well, so only the owner may scan, read-only,
-- and only this table.
CREATE POLICY inventory_migrator_scan ON inventory_saga_result_outbox
  FOR SELECT TO inventory_migrator USING (true);

CREATE FUNCTION inventory_saga_result_tenants(p_after uuid, p_limit integer)
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- Loose index scan over inventory_saga_result_pending (tenant_id leading).
  WITH RECURSIVE t(id) AS (
    (SELECT o.tenant_id FROM inventory_saga_result_outbox o
     WHERE o.published_at IS NULL
       AND o.tenant_id > COALESCE(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
     ORDER BY o.tenant_id LIMIT 1)
    UNION ALL
    SELECT (SELECT o.tenant_id FROM inventory_saga_result_outbox o
            WHERE o.published_at IS NULL AND o.tenant_id > t.id
            ORDER BY o.tenant_id LIMIT 1)
    FROM t WHERE t.id IS NOT NULL
  )
  SELECT id FROM t WHERE id IS NOT NULL
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100);
$$;
REVOKE ALL ON FUNCTION inventory_saga_result_tenants(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_saga_result_tenants(uuid, integer) TO inventory_app;
