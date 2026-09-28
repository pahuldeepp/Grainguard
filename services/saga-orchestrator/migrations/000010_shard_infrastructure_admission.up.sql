-- Explicit local infrastructure admission for placement-aware workers.
-- Reserved ownership must be seeded by trusted bootstrap before runtime.

CREATE FUNCTION greenguard_internal.admit_shard_infrastructure(p_shard text,p_incarnation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE o greenguard_internal.tenant_ownership%ROWTYPE;
BEGIN
 IF NULLIF(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM '00000000-0000-4000-8000-000000000001'::uuid THEN
  RAISE EXCEPTION 'reserved infrastructure context required' USING ERRCODE='insufficient_privilege';
 END IF;
 IF current_setting('transaction_read_only')='on' THEN
  SELECT * INTO o FROM greenguard_internal.tenant_ownership WHERE tenant_id='00000000-0000-4000-8000-000000000001'::uuid;
 ELSE
  SELECT * INTO o FROM greenguard_internal.tenant_ownership WHERE tenant_id='00000000-0000-4000-8000-000000000001'::uuid FOR SHARE;
 END IF;
 IF NOT FOUND OR o.state<>'active' OR o.shard_id IS DISTINCT FROM p_shard OR o.shard_incarnation IS DISTINCT FROM p_incarnation THEN
  RAISE EXCEPTION 'infrastructure bootstrap missing or mismatched' USING ERRCODE='insufficient_privilege';
 END IF;
 PERFORM set_config('app.shard_id',o.shard_id,true);
 PERFORM set_config('app.shard_incarnation',o.shard_incarnation::text,true);
 PERFORM set_config('app.placement_epoch',o.placement_epoch::text,true);
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.admit_shard_infrastructure(text,uuid) FROM PUBLIC;
DO $grants$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['saga_app'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION greenguard_internal.admit_shard_infrastructure(text,uuid) TO %I',role_name);
  END IF;
 END LOOP;
END $grants$;
