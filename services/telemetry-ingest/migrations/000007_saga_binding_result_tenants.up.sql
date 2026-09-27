-- Stage 07: the binding.await worker no longer takes a configured tenant list.
-- This fixed SECURITY DEFINER selector returns only tenant IDs with unpublished
-- binding results, never row data; the worker publishes each tenant's rows inside
-- that tenant's RLS transaction. p_after is a keyset cursor for round-robin
-- passes, and the batch is clamped to 1..100.
-- FORCE RLS applies to the owner as well: allow the owner a read-only scan of
-- this one table, used only by the selector below.
CREATE POLICY telemetry_migrator_scan ON saga_binding_requests
  FOR SELECT TO telemetry_migrator USING (true);

CREATE FUNCTION saga_binding_result_tenants(p_after uuid, p_limit integer)
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- Loose index scan over saga_binding_unpublished (tenant_id leading).
  WITH RECURSIVE t(id) AS (
    (SELECT r.tenant_id FROM saga_binding_requests r
     WHERE r.outcome = 'succeeded' AND r.published_at IS NULL
       AND r.tenant_id > COALESCE(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
     ORDER BY r.tenant_id LIMIT 1)
    UNION ALL
    SELECT (SELECT r.tenant_id FROM saga_binding_requests r
            WHERE r.outcome = 'succeeded' AND r.published_at IS NULL AND r.tenant_id > t.id
            ORDER BY r.tenant_id LIMIT 1)
    FROM t WHERE t.id IS NOT NULL
  )
  SELECT id FROM t WHERE id IS NOT NULL
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100);
$$;
REVOKE ALL ON FUNCTION saga_binding_result_tenants(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saga_binding_result_tenants(uuid, integer) TO telemetry_app;
