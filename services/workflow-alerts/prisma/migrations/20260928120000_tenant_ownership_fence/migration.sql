-- Durable local fence for one tenant on one operational shard.
-- Apply independently to every operational owner database. The migration leaves
-- ownership empty: a trusted control-plane placement snapshot must seed it before
-- tenant traffic is admitted. Missing placement is intentionally fail-closed.
-- See docs/runbooks/tenant-ownership.md for role, import, and rollout requirements.
SET lock_timeout = '2s';

CREATE SCHEMA IF NOT EXISTS greenguard_internal;
REVOKE ALL ON SCHEMA greenguard_internal FROM PUBLIC;
GRANT USAGE ON SCHEMA greenguard_internal TO PUBLIC;

CREATE TABLE greenguard_internal.tenant_ownership (
  tenant_id uuid PRIMARY KEY,
  shard_id text NOT NULL CHECK (shard_id IN ('s1','s2','s3','s4')),
  shard_incarnation uuid NOT NULL,
  placement_epoch bigint NOT NULL CHECK (placement_epoch >= 0),
  state text NOT NULL CHECK (state IN ('active','quiescing','fenced','prepared')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON greenguard_internal.tenant_ownership FROM PUBLIC;

-- Runtime roles must never be able to TRUNCATE tenant tables, including a
-- partition created after this migration (PostgreSQL does not clone statement
-- TRUNCATE triggers onto new partitions). Future PUBLIC table defaults stay
-- closed as well; the migration owner remains a trusted schema administrator.
DO $revoke_runtime_truncate$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'inventory_app','inventory_projector','telemetry_app','telemetry_entitlement_projector',
    'projection_app','read_entitlement_projector','risk_app','jobs_app',
    'notifications_app','alerts_app','saga_app','hardware_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM %I', role_name);
    END IF;
  END LOOP;
END
$revoke_runtime_truncate$;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM PUBLIC;

CREATE FUNCTION greenguard_internal.admit_tenant_placement(
  p_tenant_id uuid, p_shard_id text, p_incarnation uuid, p_epoch bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, greenguard_internal
AS $function$
DECLARE owner_row greenguard_internal.tenant_ownership%ROWTYPE;
BEGIN
  SELECT * INTO owner_row
    FROM greenguard_internal.tenant_ownership
   WHERE tenant_id = p_tenant_id
   FOR SHARE;
  IF NOT FOUND OR owner_row.shard_id IS DISTINCT FROM p_shard_id
     OR owner_row.shard_incarnation IS DISTINCT FROM p_incarnation
     OR owner_row.placement_epoch IS DISTINCT FROM p_epoch
     OR owner_row.state <> 'active' THEN
    RAISE EXCEPTION 'tenant placement is missing, stale, or fenced'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$function$;
REVOKE ALL ON FUNCTION greenguard_internal.admit_tenant_placement(uuid,text,uuid,bigint) FROM PUBLIC;
DO $grant_admission$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'inventory_app','inventory_projector','telemetry_app','telemetry_entitlement_projector',
    'projection_app','read_entitlement_projector','read_query','risk_app','jobs_app',
    'notifications_app','alerts_app','saga_app','hardware_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION greenguard_internal.admit_tenant_placement(uuid,text,uuid,bigint) TO %I', role_name);
    END IF;
  END LOOP;
END
$grant_admission$;

-- A runtime cannot seed or change ownership. The bootstrap role is created by
-- deployment bootstrap and receives this one function only; it must load a
-- verified snapshot exported from central placement authority.
CREATE FUNCTION greenguard_internal.seed_tenant_ownership(
  p_snapshot jsonb, p_local_shard_id text, p_local_incarnation uuid,
  p_expected_count integer
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, greenguard_internal
AS $function$
DECLARE inserted_count integer;
BEGIN
  IF p_local_shard_id IS NULL OR p_local_shard_id NOT IN ('s1','s2','s3','s4') OR p_local_incarnation IS NULL
     OR p_expected_count IS NULL OR p_expected_count < 0
     OR jsonb_typeof(p_snapshot) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid tenant placement snapshot';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_snapshot)
      AS x("tenantId" uuid, "shardId" text, "shardIncarnation" uuid, "placementEpoch" bigint, state text)
     WHERE "tenantId" IS NULL OR "tenantId" = '00000000-0000-0000-0000-000000000000'::uuid
        OR "shardId" IS NULL OR "shardId" NOT IN ('s1','s2','s3','s4')
        OR "shardIncarnation" IS NULL OR "placementEpoch" IS NULL OR "placementEpoch" < 0
        OR x.state IS DISTINCT FROM 'active'
  ) THEN
    RAISE EXCEPTION 'snapshot contains invalid or non-active placement';
  END IF;
  IF (SELECT count(*) FROM jsonb_to_recordset(p_snapshot)
        AS x("tenantId" uuid, "shardId" text, "shardIncarnation" uuid, "placementEpoch" bigint, state text))
     <> (SELECT count(DISTINCT "tenantId") FROM jsonb_to_recordset(p_snapshot)
        AS x("tenantId" uuid, "shardId" text, "shardIncarnation" uuid, "placementEpoch" bigint, state text)) THEN
    RAISE EXCEPTION 'snapshot contains duplicate tenant placement';
  END IF;
  -- Validate the complete local slice before changing any fence. A partial
  -- export must not fence live tenants and then fail a post-commit count check.
  IF (SELECT count(*) FROM jsonb_to_recordset(p_snapshot)
        AS x("tenantId" uuid, "shardId" text, "shardIncarnation" uuid, "placementEpoch" bigint, state text)
       WHERE "shardId" = p_local_shard_id AND "shardIncarnation" = p_local_incarnation)
      <> p_expected_count THEN
    RAISE EXCEPTION 'snapshot local assignment count does not match authority';
  END IF;
  -- A full authoritative snapshot may show that a tenant has moved off this
  -- shard. Fence stale local rows before importing the target assignments. Do
  -- not advance/change a conflicting row here; a same-shard epoch/incarnation
  -- change still requires the explicit move/restore protocol.
  UPDATE greenguard_internal.tenant_ownership owner_row
     SET state = 'fenced', updated_at = clock_timestamp()
   WHERE owner_row.shard_id = p_local_shard_id
     AND owner_row.state <> 'fenced'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_to_recordset(p_snapshot)
         AS x("tenantId" uuid, "shardId" text, "shardIncarnation" uuid, "placementEpoch" bigint, state text)
        WHERE "tenantId" = owner_row.tenant_id
          AND "shardId" = owner_row.shard_id
          AND "shardIncarnation" = owner_row.shard_incarnation
          AND "placementEpoch" = owner_row.placement_epoch
          AND x.state = 'active'
     );
  INSERT INTO greenguard_internal.tenant_ownership
    (tenant_id, shard_id, shard_incarnation, placement_epoch, state)
  SELECT "tenantId", "shardId", p_local_incarnation, "placementEpoch", state
    FROM jsonb_to_recordset(p_snapshot)
      AS x("tenantId" uuid, "shardId" text, "shardIncarnation" uuid, "placementEpoch" bigint, state text)
   WHERE "shardId" = p_local_shard_id
     AND "shardIncarnation" = p_local_incarnation
  ON CONFLICT (tenant_id) DO NOTHING;
  SELECT count(*) INTO inserted_count
    FROM greenguard_internal.tenant_ownership owner_row
    JOIN jsonb_to_recordset(p_snapshot)
      AS x("tenantId" uuid, "shardId" text, "shardIncarnation" uuid, "placementEpoch" bigint, state text)
      ON "tenantId" = owner_row.tenant_id
     AND "shardId" = owner_row.shard_id
     AND "shardIncarnation" = owner_row.shard_incarnation
     AND "placementEpoch" = owner_row.placement_epoch
     AND x.state = owner_row.state
   WHERE owner_row.shard_id = p_local_shard_id
     AND owner_row.shard_incarnation = p_local_incarnation;
  IF inserted_count <> p_expected_count THEN
    RAISE EXCEPTION 'imported local assignment count does not match authority';
  END IF;
  RETURN inserted_count;
END
$function$;
REVOKE ALL ON FUNCTION greenguard_internal.seed_tenant_ownership(jsonb,text,uuid,integer) FROM PUBLIC;
DO $grant_bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_ownership_bootstrap') THEN
    RAISE EXCEPTION 'tenant_ownership_bootstrap role must exist before owner migrations';
  END IF;
  GRANT EXECUTE ON FUNCTION greenguard_internal.seed_tenant_ownership(jsonb,text,uuid,integer)
    TO tenant_ownership_bootstrap;
END
$grant_bootstrap$;

CREATE FUNCTION greenguard_internal.enforce_tenant_ownership()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, greenguard_internal
AS $function$
DECLARE row_data jsonb; row_tenant uuid; route_tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN row_data := to_jsonb(OLD); ELSE row_data := to_jsonb(NEW); END IF;
  row_tenant := NULLIF(row_data->>'tenant_id','')::uuid;
  IF row_tenant IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD)->>'tenant_id') IS DISTINCT FROM (to_jsonb(NEW)->>'tenant_id') THEN
    RAISE EXCEPTION 'tenant_id is immutable' USING ERRCODE = 'insufficient_privilege';
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

CREATE FUNCTION greenguard_internal.forbid_tenant_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'TRUNCATE is forbidden on tenant-owned tables'
    USING ERRCODE = 'insufficient_privilege';
END
$function$;
REVOKE ALL ON FUNCTION greenguard_internal.forbid_tenant_truncate() FROM PUBLIC;

CREATE FUNCTION greenguard_internal.assert_tenant_fences_installed()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, greenguard_internal
AS $function$
DECLARE unfenced text;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY n.nspname, c.relname)
    INTO unfenced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
     AND a.attnum > 0 AND NOT a.attisdropped
     AND (
       NOT EXISTS (SELECT 1 FROM pg_trigger tr
         WHERE tr.tgrelid = c.oid AND tr.tgname = 'tenant_ownership_row_fence')
       OR NOT EXISTS (SELECT 1 FROM pg_trigger tr
         WHERE tr.tgrelid = c.oid AND NOT tr.tgisinternal
           AND tr.tgname = 'tenant_ownership_truncate_fence')
     );
  IF unfenced IS NOT NULL THEN
    RAISE EXCEPTION 'tenant ownership fence missing on: %', unfenced
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$function$;
REVOKE ALL ON FUNCTION greenguard_internal.assert_tenant_fences_installed() FROM PUBLIC;
DO $grant_fence_audit$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_ownership_bootstrap') THEN
    GRANT EXECUTE ON FUNCTION greenguard_internal.assert_tenant_fences_installed()
      TO tenant_ownership_bootstrap;
  END IF;
END
$grant_fence_audit$;

DO $install_triggers$
DECLARE t record; trigger_name text;
BEGIN
  FOR t IN
    SELECT n.nspname, c.relname, c.relispartition
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
       AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    IF NOT t.relispartition THEN
      trigger_name := 'tenant_ownership_row_fence';
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', trigger_name, t.nspname, t.relname);
      EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION greenguard_internal.enforce_tenant_ownership()', trigger_name, t.nspname, t.relname);
    END IF;
    trigger_name := 'tenant_ownership_truncate_fence';
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', trigger_name, t.nspname, t.relname);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION greenguard_internal.forbid_tenant_truncate()', trigger_name, t.nspname, t.relname);
  END LOOP;
END
$install_triggers$;

SELECT greenguard_internal.assert_tenant_fences_installed();
RESET lock_timeout;
