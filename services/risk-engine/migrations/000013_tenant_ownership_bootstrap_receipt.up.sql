-- Read-only, least-privilege proof for tenant bootstrap orchestration.
-- The returned version identifies this SQL contract only; it is not a claim
-- that all service migrations were applied. Applied service migrations must be
-- verified independently through each service's actual migration ledger.
CREATE FUNCTION greenguard_internal.tenant_ownership_bootstrap_contract_version()
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT 'tenant-ownership-bootstrap-v2'::text
$function$;
REVOKE ALL ON FUNCTION greenguard_internal.tenant_ownership_bootstrap_contract_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.tenant_ownership_bootstrap_contract_version()
  TO tenant_ownership_bootstrap;

CREATE FUNCTION greenguard_internal.get_tenant_ownership_bootstrap_receipt(
  p_tenant_id uuid,
  p_shard_id text,
  p_incarnation uuid,
  p_epoch bigint
) RETURNS TABLE (
  receipt_version text,
  tenant_id uuid,
  shard_id text,
  shard_incarnation uuid,
  placement_epoch bigint,
  state text,
  observed_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, greenguard_internal
AS $function$
DECLARE owner_row greenguard_internal.tenant_ownership%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
     OR p_shard_id IS NULL OR p_shard_id NOT IN ('s1','s2','s3','s4')
     OR p_incarnation IS NULL OR p_incarnation = '00000000-0000-0000-0000-000000000000'::uuid
     OR p_epoch IS NULL OR p_epoch <= 0 THEN
    RAISE EXCEPTION 'invalid tenant ownership receipt identity';
  END IF;

  SELECT ownership.* INTO owner_row
    FROM greenguard_internal.tenant_ownership AS ownership
   WHERE ownership.tenant_id = p_tenant_id;
  IF NOT FOUND OR owner_row.shard_id IS DISTINCT FROM p_shard_id
     OR owner_row.shard_incarnation IS DISTINCT FROM p_incarnation
     OR owner_row.placement_epoch IS DISTINCT FROM p_epoch
     OR owner_row.state NOT IN ('prepared','active') THEN
    RAISE EXCEPTION 'tenant ownership receipt is absent or does not match requested placement';
  END IF;

  RETURN QUERY SELECT
    'tenant-ownership-bootstrap-v2'::text,
    owner_row.tenant_id,
    owner_row.shard_id,
    owner_row.shard_incarnation,
    owner_row.placement_epoch,
    owner_row.state,
    owner_row.updated_at;
END
$function$;
REVOKE ALL ON FUNCTION greenguard_internal.get_tenant_ownership_bootstrap_receipt(uuid,text,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.get_tenant_ownership_bootstrap_receipt(uuid,text,uuid,bigint)
  TO tenant_ownership_bootstrap;
