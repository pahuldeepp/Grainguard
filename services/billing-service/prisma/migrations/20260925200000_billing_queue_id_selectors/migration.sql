-- Queue rows are cross-tenant discovery indexes. The runtime may see identifiers
-- only; status, timing, lease and attempt metadata stay inside definer functions.
REVOKE SELECT ON billing_inbox.command_work, billing_inbox.due_work FROM billing_app;
GRANT SELECT (tenant_id, command_id) ON billing_inbox.command_work TO billing_app;
GRANT SELECT (tenant_id, kind) ON billing_inbox.due_work TO billing_app;

CREATE FUNCTION billing_inbox.claim_command_work()
RETURNS TABLE (tenant_id uuid, command_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, billing_inbox
AS $$
  WITH next AS (
    SELECT work.tenant_id, work.command_id
      FROM billing_inbox.command_work AS work
     WHERE (work.status = 'pending' AND work.available_at <= clock_timestamp())
        OR (work.status = 'running' AND work.lease_until < clock_timestamp())
     ORDER BY work.available_at, work.tenant_id, work.command_id
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE billing_inbox.command_work AS work
     SET status = 'running', attempts = work.attempts + 1,
         lease_until = clock_timestamp() + interval '60 seconds',
         updated_at = clock_timestamp()
    FROM next
   WHERE work.tenant_id = next.tenant_id AND work.command_id = next.command_id
  RETURNING work.tenant_id, work.command_id
$$;
REVOKE ALL ON FUNCTION billing_inbox.claim_command_work() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_inbox.claim_command_work() TO billing_app;

CREATE FUNCTION billing_inbox.ready_due_tenants(p_kind text, p_cutoff timestamptz, p_limit integer)
RETURNS TABLE (tenant_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, billing_inbox
AS $$
BEGIN
  IF p_kind NOT IN ('subscription', 'usage') OR p_cutoff IS NULL
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'invalid due-work selector arguments' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT work.tenant_id
      FROM billing_inbox.due_work AS work
     WHERE work.kind = p_kind AND work.status = 'pending' AND work.due_at <= p_cutoff
     ORDER BY work.due_at, work.tenant_id
     LIMIT p_limit;
END
$$;
REVOKE ALL ON FUNCTION billing_inbox.ready_due_tenants(text, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_inbox.ready_due_tenants(text, timestamptz, integer) TO billing_app;
