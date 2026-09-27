-- Keep queue contents and scheduling state private from billing_app. The worker
-- discovers identifiers through narrow selectors; tenant-owned mutations go
-- through SECURITY DEFINER functions that require the transaction tenant context.
REVOKE INSERT, UPDATE ON billing_inbox.command_work, billing_inbox.due_work FROM billing_app;

CREATE FUNCTION billing_inbox.set_due_work(p_tenant_id uuid, p_kind text, p_due_at timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, billing_inbox
AS $$
BEGIN
  IF current_setting('app.tenant_id', true) IS NULL
     OR current_setting('app.tenant_id', true)::uuid <> p_tenant_id
     OR p_kind NOT IN ('subscription', 'usage') THEN
    RAISE EXCEPTION 'invalid tenant or due-work scope' USING ERRCODE = '42501';
  END IF;
  IF p_due_at IS NULL THEN
    UPDATE billing_inbox.due_work SET status = 'done'
     WHERE tenant_id = p_tenant_id AND kind = p_kind;
  ELSE
    INSERT INTO billing_inbox.due_work (tenant_id, kind, due_at)
    VALUES (p_tenant_id, p_kind, p_due_at)
    ON CONFLICT (tenant_id, kind) DO UPDATE
      SET due_at = EXCLUDED.due_at, status = 'pending';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION billing_inbox.set_due_work(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_inbox.set_due_work(uuid, text, timestamptz) TO billing_app;

CREATE FUNCTION billing_inbox.reset_command_work(p_tenant_id uuid, p_command_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, billing_inbox
AS $$
DECLARE changed integer;
BEGIN
  IF current_setting('app.tenant_id', true) IS NULL
     OR current_setting('app.tenant_id', true)::uuid <> p_tenant_id THEN
    RAISE EXCEPTION 'invalid tenant command-work scope' USING ERRCODE = '42501';
  END IF;
  UPDATE billing_inbox.command_work
     SET status = 'pending', lease_until = NULL, available_at = clock_timestamp(),
         updated_at = clock_timestamp()
   WHERE tenant_id = p_tenant_id AND command_id = p_command_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;
REVOKE ALL ON FUNCTION billing_inbox.reset_command_work(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_inbox.reset_command_work(uuid, uuid) TO billing_app;

CREATE FUNCTION billing_inbox.finish_command_work(
  p_tenant_id uuid, p_command_id uuid, p_status text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, billing_inbox
AS $$
DECLARE changed integer;
BEGIN
  IF current_setting('app.tenant_id', true) IS NULL
     OR current_setting('app.tenant_id', true)::uuid <> p_tenant_id
     OR p_status NOT IN ('pending', 'completed', 'quarantined') THEN
    RAISE EXCEPTION 'invalid tenant or command-work transition' USING ERRCODE = '42501';
  END IF;
  UPDATE billing_inbox.command_work
     SET status = p_status, lease_until = NULL, updated_at = clock_timestamp(),
         available_at = clock_timestamp()
           + make_interval(secs => LEAST(300, power(2, LEAST(attempts, 8))))
   WHERE tenant_id = p_tenant_id AND command_id = p_command_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;
REVOKE ALL ON FUNCTION billing_inbox.finish_command_work(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_inbox.finish_command_work(uuid, uuid, text) TO billing_app;
