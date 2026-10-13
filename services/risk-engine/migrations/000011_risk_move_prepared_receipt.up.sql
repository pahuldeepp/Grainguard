-- Preserve Risk's original target preparation proof when the operation receipt
-- advances to copy_verified/activated. This is owner-specific evidence: the
-- generic Risk copier must be able to replay the exact preparation capability.
ALTER TABLE greenguard_internal.tenant_move_operations
  ADD COLUMN target_prepared_receipt jsonb;

UPDATE greenguard_internal.tenant_move_operations
SET target_prepared_receipt = jsonb_build_object(
  'tenantId', tenant_id,
  'operationId', operation_id,
  'owner', 'risk',
  'phase', 'target_prepared',
  'shardId', target_shard_id,
  'incarnation', target_incarnation,
  'epoch', target_epoch::text,
  'state', 'prepared',
  'sourceShardId', source_shard_id,
  'sourceIncarnation', source_incarnation,
  'sourceEpoch', source_epoch::text,
  'targetShardId', target_shard_id,
  'targetIncarnation', target_incarnation,
  'targetEpoch', target_epoch::text
)
WHERE endpoint_role = 'target';

ALTER TABLE greenguard_internal.tenant_move_operations
  ADD CONSTRAINT tenant_move_prepared_receipt_role_check CHECK (
    (endpoint_role = 'target' AND jsonb_typeof(target_prepared_receipt) = 'object') OR
    (endpoint_role = 'source' AND target_prepared_receipt IS NULL)
  );

CREATE OR REPLACE FUNCTION greenguard_internal.prepare_tenant_move_target(
  p_tenant uuid,p_operation uuid,p_source_shard text,p_source_incarnation uuid,p_source_epoch bigint,
  p_target_shard text,p_target_incarnation uuid,p_target_epoch bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE table_row record; has_rows boolean; existing greenguard_internal.tenant_move_operations%ROWTYPE; proof jsonb;
BEGIN
  IF p_tenant IS NULL OR p_operation IS NULL OR p_source_shard NOT IN ('s1','s2','s3','s4') OR
     p_target_shard NOT IN ('s1','s2','s3','s4') OR p_source_shard=p_target_shard OR
     p_source_incarnation IS NULL OR p_target_incarnation IS NULL OR p_source_epoch<=0 OR p_target_epoch<>p_source_epoch+1 THEN
    RAISE EXCEPTION 'invalid tenant move target identity';
  END IF;
  SELECT * INTO existing FROM greenguard_internal.tenant_move_operations
    WHERE tenant_id=p_tenant AND operation_id=p_operation FOR UPDATE;
  IF FOUND THEN
    IF existing.endpoint_role<>'target' OR existing.source_shard_id<>p_source_shard OR
       existing.source_incarnation<>p_source_incarnation OR existing.source_epoch<>p_source_epoch OR
       existing.target_shard_id<>p_target_shard OR existing.target_incarnation<>p_target_incarnation OR
       existing.target_epoch<>p_target_epoch THEN RAISE EXCEPTION 'tenant move operation identity conflict'; END IF;
    RETURN existing.target_prepared_receipt;
  END IF;
  IF EXISTS (SELECT 1 FROM greenguard_internal.tenant_ownership WHERE tenant_id=p_tenant) THEN
    RAISE EXCEPTION 'target already has tenant ownership';
  END IF;
  PERFORM set_config('app.tenant_id',p_tenant::text,true);
  FOR table_row IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attname='tenant_id' AND a.attnum>0 AND NOT a.attisdropped
  LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE tenant_id=$1)',table_row.relname) INTO has_rows USING p_tenant;
    IF has_rows THEN RAISE EXCEPTION 'target already contains tenant rows in %',table_row.relname; END IF;
  END LOOP;
  proof:=jsonb_build_object('tenantId',p_tenant,'operationId',p_operation,'owner','risk','phase','target_prepared',
    'shardId',p_target_shard,'incarnation',p_target_incarnation,'epoch',p_target_epoch::text,'state','prepared',
    'sourceShardId',p_source_shard,'sourceIncarnation',p_source_incarnation,'sourceEpoch',p_source_epoch::text,
    'targetShardId',p_target_shard,'targetIncarnation',p_target_incarnation,'targetEpoch',p_target_epoch::text);
  INSERT INTO greenguard_internal.tenant_move_operations
    (tenant_id,operation_id,endpoint_role,source_shard_id,source_incarnation,source_epoch,target_shard_id,target_incarnation,target_epoch,state,receipt,target_prepared_receipt)
  VALUES(p_tenant,p_operation,'target',p_source_shard,p_source_incarnation,p_source_epoch,p_target_shard,p_target_incarnation,p_target_epoch,'prepared',proof,proof);
  INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state)
  VALUES(p_tenant,p_target_shard,p_target_incarnation,p_target_epoch,'prepared');
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.prepare_tenant_move_target(uuid,uuid,text,uuid,bigint,text,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.prepare_tenant_move_target(uuid,uuid,text,uuid,bigint,text,uuid,bigint) TO risk_migrator;
