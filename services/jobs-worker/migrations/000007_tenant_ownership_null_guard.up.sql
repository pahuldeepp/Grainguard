-- Forward-only correction: a fenced tenant table never admits a NULL tenant.
-- Original ownership migrations remain unchanged for deployed checksum ledgers.
CREATE OR REPLACE FUNCTION greenguard_internal.enforce_tenant_ownership()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, greenguard_internal
AS $function$
DECLARE row_data jsonb; row_tenant uuid; route_tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN row_data := to_jsonb(OLD); ELSE row_data := to_jsonb(NEW); END IF;
  row_tenant := NULLIF(row_data->>'tenant_id','')::uuid;
  -- Check identity changes before handling NULL, so tenant -> NULL cannot
  -- evade immutability on a nullable column introduced in a later migration.
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD)->>'tenant_id') IS DISTINCT FROM (to_jsonb(NEW)->>'tenant_id') THEN
    RAISE EXCEPTION 'tenant_id is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF row_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant ownership requires a non-null tenant_id'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  route_tenant := NULLIF(current_setting('app.tenant_id', true),'')::uuid;
  IF route_tenant IS DISTINCT FROM row_tenant THEN
    RAISE EXCEPTION 'tenant context does not match row tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM greenguard_internal.admit_tenant_placement(
    route_tenant,
    NULLIF(current_setting('app.shard_id', true),''),
    NULLIF(current_setting('app.shard_incarnation', true),'')::uuid,
    NULLIF(current_setting('app.placement_epoch', true),'')::bigint
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END
$function$;
REVOKE ALL ON FUNCTION greenguard_internal.enforce_tenant_ownership() FROM PUBLIC;
