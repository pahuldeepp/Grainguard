-- Per-tenant bootstrap contract copied into every operational owner database.
-- Unlike seed_tenant_ownership(snapshot), this API can only touch one explicit
-- tenant and never interprets omission from a snapshot as a fence instruction.
CREATE FUNCTION greenguard_internal.prepare_tenant_ownership(
  p_tenant_id uuid,
  p_shard_id text,
  p_incarnation uuid,
  p_epoch bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, greenguard_internal
AS $function$
DECLARE owner_row greenguard_internal.tenant_ownership%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
     OR p_shard_id IS NULL OR p_shard_id NOT IN ('s1','s2','s3','s4')
     OR p_incarnation IS NULL OR p_incarnation = '00000000-0000-0000-0000-000000000000'::uuid
     OR p_epoch IS NULL OR p_epoch <= 0 THEN
    RAISE EXCEPTION 'invalid tenant ownership placement';
  END IF;

  INSERT INTO greenguard_internal.tenant_ownership
    (tenant_id, shard_id, shard_incarnation, placement_epoch, state)
  VALUES (p_tenant_id, p_shard_id, p_incarnation, p_epoch, 'prepared')
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT * INTO owner_row
    FROM greenguard_internal.tenant_ownership
   WHERE tenant_id = p_tenant_id
   FOR UPDATE;
  IF NOT FOUND OR owner_row.shard_id IS DISTINCT FROM p_shard_id
     OR owner_row.shard_incarnation IS DISTINCT FROM p_incarnation
     OR owner_row.placement_epoch IS DISTINCT FROM p_epoch
     OR owner_row.state IS DISTINCT FROM 'prepared' THEN
    RAISE EXCEPTION 'tenant ownership conflicts with bootstrap placement';
  END IF;
  -- Exact replay is a no-op. This function cannot activate, move, or fence.
END
$function$;

CREATE FUNCTION greenguard_internal.activate_tenant_ownership(
  p_tenant_id uuid,
  p_shard_id text,
  p_incarnation uuid,
  p_epoch bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, greenguard_internal
AS $function$
DECLARE owner_row greenguard_internal.tenant_ownership%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
     OR p_shard_id IS NULL OR p_shard_id NOT IN ('s1','s2','s3','s4')
     OR p_incarnation IS NULL OR p_incarnation = '00000000-0000-0000-0000-000000000000'::uuid
     OR p_epoch IS NULL OR p_epoch <= 0 THEN
    RAISE EXCEPTION 'invalid tenant ownership placement';
  END IF;

  UPDATE greenguard_internal.tenant_ownership
     SET state = 'active', updated_at = clock_timestamp()
   WHERE tenant_id = p_tenant_id
     AND shard_id = p_shard_id
     AND shard_incarnation = p_incarnation
     AND placement_epoch = p_epoch
     AND state = 'prepared';

  IF NOT FOUND THEN
    SELECT * INTO owner_row
      FROM greenguard_internal.tenant_ownership
     WHERE tenant_id = p_tenant_id
     FOR UPDATE;
    -- Allow exact replay after a lost acknowledgement; reject absent, fenced,
    -- different-shard, different-incarnation, or different-epoch ownership.
    IF NOT FOUND OR owner_row.shard_id IS DISTINCT FROM p_shard_id
       OR owner_row.shard_incarnation IS DISTINCT FROM p_incarnation
       OR owner_row.placement_epoch IS DISTINCT FROM p_epoch
       OR owner_row.state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'tenant ownership is not prepared for requested activation';
    END IF;
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION greenguard_internal.prepare_tenant_ownership(uuid,text,uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION greenguard_internal.activate_tenant_ownership(uuid,text,uuid,bigint) FROM PUBLIC;
-- Retire the old snapshot importer: its NOT EXISTS clause can fence live rows
-- omitted from an incomplete snapshot. It is still present for compatibility
-- with already-applied migrations, but the bootstrap principal must not call it.
REVOKE ALL ON FUNCTION greenguard_internal.seed_tenant_ownership(jsonb,text,uuid,integer)
  FROM tenant_ownership_bootstrap;
GRANT EXECUTE ON FUNCTION greenguard_internal.prepare_tenant_ownership(uuid,text,uuid,bigint)
  TO tenant_ownership_bootstrap;
GRANT EXECUTE ON FUNCTION greenguard_internal.activate_tenant_ownership(uuid,text,uuid,bigint)
  TO tenant_ownership_bootstrap;
