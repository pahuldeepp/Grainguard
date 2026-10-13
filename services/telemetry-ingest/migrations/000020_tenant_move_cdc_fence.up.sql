-- A row-only tenant copy must not re-publish immutable outbox records through
-- logical CDC on the destination. Reject history under the ownership row lock;
-- admit_tenant_placement takes FOR SHARE so accepted writers have drained.
CREATE FUNCTION greenguard_internal.tenant_move_has_cdc_history(p_tenant uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
BEGIN
  IF p_tenant IS NULL THEN RAISE EXCEPTION 'telemetry CDC check requires tenant id'; END IF;
  PERFORM set_config('app.tenant_id',p_tenant::text,true);
  RETURN EXISTS (SELECT 1 FROM public.outbox_events WHERE tenant_id=p_tenant);
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.tenant_move_has_cdc_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.tenant_move_has_cdc_history(uuid) TO telemetry_migrator;

CREATE OR REPLACE FUNCTION greenguard_internal.fence_tenant_move_source(
  p_tenant uuid,p_operation uuid,p_source_shard text,p_source_incarnation uuid,p_source_epoch bigint,
  p_target_shard text,p_target_incarnation uuid,p_target_epoch bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE existing greenguard_internal.tenant_move_operations%ROWTYPE; owner_row greenguard_internal.tenant_ownership%ROWTYPE; proof jsonb;
BEGIN
  IF p_tenant IS NULL OR p_operation IS NULL OR p_source_shard NOT IN ('s1','s2','s3','s4') OR
     p_target_shard NOT IN ('s1','s2','s3','s4') OR p_source_shard=p_target_shard OR
     p_source_incarnation IS NULL OR p_target_incarnation IS NULL OR p_source_epoch<=0 OR p_target_epoch<>p_source_epoch+1 THEN
    RAISE EXCEPTION 'invalid telemetry tenant move source identity';
  END IF;
  SELECT * INTO existing FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation FOR UPDATE;
  IF FOUND THEN
    IF existing.endpoint_role<>'source' OR existing.state NOT IN ('source_fenced','source_reactivated') OR
       existing.source_shard_id<>p_source_shard OR existing.source_incarnation<>p_source_incarnation OR
       existing.source_epoch<>p_source_epoch OR existing.target_shard_id<>p_target_shard OR
       existing.target_incarnation<>p_target_incarnation OR existing.target_epoch<>p_target_epoch THEN
      RAISE EXCEPTION 'telemetry tenant move source operation identity conflict';
    END IF;
    RETURN jsonb_set(existing.receipt,'{owner}','"telemetry"'::jsonb,true);
  END IF;
  SELECT * INTO owner_row FROM greenguard_internal.tenant_ownership WHERE tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND OR owner_row.shard_id<>p_source_shard OR owner_row.shard_incarnation<>p_source_incarnation OR
     owner_row.placement_epoch<>p_source_epoch OR owner_row.state<>'active' THEN
    RAISE EXCEPTION 'telemetry source tenant ownership does not match move';
  END IF;
  PERFORM set_config('app.tenant_id',p_tenant::text,true);
  IF EXISTS (SELECT 1 FROM public.outbox_events WHERE tenant_id=p_tenant) THEN
    RAISE EXCEPTION 'telemetry move blocked: CDC outbox history needs a deduplication-aware migration protocol';
  END IF;
  UPDATE greenguard_internal.tenant_ownership SET state='fenced',updated_at=clock_timestamp() WHERE tenant_id=p_tenant;
  proof:=jsonb_build_object('tenantId',p_tenant,'operationId',p_operation,'phase','source_fenced','owner','telemetry',
    'shardId',p_source_shard,'incarnation',p_source_incarnation,'epoch',p_source_epoch::text,'state','fenced',
    'sourceShardId',p_source_shard,'sourceIncarnation',p_source_incarnation,'sourceEpoch',p_source_epoch::text,
    'targetShardId',p_target_shard,'targetIncarnation',p_target_incarnation,'targetEpoch',p_target_epoch::text);
  INSERT INTO greenguard_internal.tenant_move_operations
    (tenant_id,operation_id,endpoint_role,source_shard_id,source_incarnation,source_epoch,target_shard_id,target_incarnation,target_epoch,state,receipt,preparation_receipt)
  VALUES(p_tenant,p_operation,'source',p_source_shard,p_source_incarnation,p_source_epoch,p_target_shard,p_target_incarnation,p_target_epoch,'source_fenced',proof,proof);
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.fence_tenant_move_source(uuid,uuid,text,uuid,bigint,text,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.fence_tenant_move_source(uuid,uuid,text,uuid,bigint,text,uuid,bigint) TO telemetry_migrator;
