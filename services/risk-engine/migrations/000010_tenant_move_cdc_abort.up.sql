-- Stage 12 owner hardening: Risk CDC history has no deduplication-aware move
-- protocol yet. Source fencing fails closed while holding the same ownership row
-- lock used by writers. Receipts are explicitly owner-tagged for the placement
-- receipt roster. Target abort/source reactivation are owner-local and idempotent.
DO $state_check$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint
   WHERE conrelid='greenguard_internal.tenant_move_operations'::regclass
     AND contype='c' AND pg_get_constraintdef(oid) LIKE '%state%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE greenguard_internal.tenant_move_operations DROP CONSTRAINT %I',constraint_name);
  END IF;
END
$state_check$;
ALTER TABLE greenguard_internal.tenant_move_operations
  ADD CONSTRAINT tenant_move_operations_state_check
  CHECK (state IN ('prepared','source_fenced','copy_verified','activated','aborted','source_reactivated'));

UPDATE greenguard_internal.tenant_move_operations
 SET receipt=jsonb_set(receipt,'{owner}','"risk"'::jsonb,true);

CREATE FUNCTION greenguard_internal.tag_risk_move_receipts()
RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,greenguard_internal AS $$
BEGIN
  NEW.receipt:=jsonb_set(NEW.receipt,'{owner}','"risk"'::jsonb,true);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.tag_risk_move_receipts() FROM PUBLIC;
CREATE TRIGGER tag_risk_move_receipts
 BEFORE INSERT OR UPDATE
 ON greenguard_internal.tenant_move_operations
 FOR EACH ROW EXECUTE FUNCTION greenguard_internal.tag_risk_move_receipts();

CREATE FUNCTION greenguard_internal.tenant_move_status(p_tenant uuid,p_operation uuid,p_endpoint_role text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE op greenguard_internal.tenant_move_operations%ROWTYPE;
BEGIN
  IF p_endpoint_role NOT IN ('source','target') THEN RAISE EXCEPTION 'invalid Risk move endpoint role'; END IF;
  SELECT * INTO op FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role=p_endpoint_role;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('state',op.state,'receipt',op.receipt);
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.tenant_move_status(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.tenant_move_status(uuid,uuid,text) TO risk_migrator;

-- v9 routines returned their local JSON variable, which runs before the receipt
-- tagging trigger and therefore omitted owner identity in the function result. Keep
-- their reviewed state transitions, but expose the committed owner-tagged row.
ALTER FUNCTION greenguard_internal.prepare_tenant_move_target(uuid,uuid,text,uuid,bigint,text,uuid,bigint)
  RENAME TO risk_v9_prepare_tenant_move_target;
ALTER FUNCTION greenguard_internal.record_tenant_move_copy(uuid,uuid,text,text,bigint,integer)
  RENAME TO risk_v9_record_tenant_move_copy;
ALTER FUNCTION greenguard_internal.activate_tenant_move_target(uuid,uuid)
  RENAME TO risk_v9_activate_tenant_move_target;

CREATE FUNCTION greenguard_internal.prepare_tenant_move_target(
  p_tenant uuid,p_operation uuid,p_source_shard text,p_source_incarnation uuid,p_source_epoch bigint,
  p_target_shard text,p_target_incarnation uuid,p_target_epoch bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE proof jsonb;
BEGIN
  PERFORM greenguard_internal.risk_v9_prepare_tenant_move_target(
    p_tenant,p_operation,p_source_shard,p_source_incarnation,p_source_epoch,p_target_shard,p_target_incarnation,p_target_epoch);
  SELECT receipt INTO proof FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='target';
  IF proof IS NULL THEN RAISE EXCEPTION 'Risk target preparation receipt was not persisted'; END IF;
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.prepare_tenant_move_target(uuid,uuid,text,uuid,bigint,text,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.prepare_tenant_move_target(uuid,uuid,text,uuid,bigint,text,uuid,bigint) TO risk_migrator;

CREATE FUNCTION greenguard_internal.record_tenant_move_copy(
  p_tenant uuid,p_operation uuid,p_source_sha256 text,p_target_sha256 text,p_row_count bigint,p_table_count integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE proof jsonb;
BEGIN
  PERFORM greenguard_internal.risk_v9_record_tenant_move_copy(
    p_tenant,p_operation,p_source_sha256,p_target_sha256,p_row_count,p_table_count);
  SELECT receipt INTO proof FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='target';
  IF proof IS NULL THEN RAISE EXCEPTION 'Risk copy receipt was not persisted'; END IF;
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.record_tenant_move_copy(uuid,uuid,text,text,bigint,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.record_tenant_move_copy(uuid,uuid,text,text,bigint,integer) TO risk_migrator;

CREATE FUNCTION greenguard_internal.activate_tenant_move_target(p_tenant uuid,p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE proof jsonb;
BEGIN
  PERFORM greenguard_internal.risk_v9_activate_tenant_move_target(p_tenant,p_operation);
  SELECT receipt INTO proof FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='target';
  IF proof IS NULL THEN RAISE EXCEPTION 'Risk activation receipt was not persisted'; END IF;
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.activate_tenant_move_target(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.activate_tenant_move_target(uuid,uuid) TO risk_migrator;

CREATE FUNCTION greenguard_internal.tenant_move_has_cdc_history(p_tenant uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
BEGIN
  IF p_tenant IS NULL THEN RAISE EXCEPTION 'Risk CDC check requires tenant id'; END IF;
  PERFORM set_config('app.tenant_id',p_tenant::text,true);
  RETURN EXISTS (SELECT 1 FROM public.outbox_events WHERE tenant_id=p_tenant);
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.tenant_move_has_cdc_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.tenant_move_has_cdc_history(uuid) TO risk_migrator;

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
    RAISE EXCEPTION 'invalid Risk tenant move source identity';
  END IF;
  SELECT * INTO existing FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation FOR UPDATE;
  IF FOUND THEN
    IF existing.endpoint_role<>'source' OR existing.state NOT IN ('source_fenced','source_reactivated') OR
       existing.source_shard_id<>p_source_shard OR existing.source_incarnation<>p_source_incarnation OR
       existing.source_epoch<>p_source_epoch OR existing.target_shard_id<>p_target_shard OR
       existing.target_incarnation<>p_target_incarnation OR existing.target_epoch<>p_target_epoch THEN
      RAISE EXCEPTION 'Risk tenant move source operation identity conflict';
    END IF;
    RETURN jsonb_set(existing.receipt,'{owner}','"risk"'::jsonb,true);
  END IF;
  SELECT * INTO owner_row FROM greenguard_internal.tenant_ownership WHERE tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND OR owner_row.shard_id<>p_source_shard OR owner_row.shard_incarnation<>p_source_incarnation OR
     owner_row.placement_epoch<>p_source_epoch OR owner_row.state<>'active' THEN
    RAISE EXCEPTION 'Risk source tenant ownership does not match move';
  END IF;
  -- admit_tenant_placement takes FOR SHARE, so this row lock drains accepted writes
  -- before the query. Any historical outbox row could be replayed by CDC on the
  -- target; reject until a dedupe-aware outbox migration protocol exists.
  PERFORM set_config('app.tenant_id',p_tenant::text,true);
  IF EXISTS (SELECT 1 FROM public.outbox_events WHERE tenant_id=p_tenant) THEN
    RAISE EXCEPTION 'Risk move blocked: CDC outbox history needs a deduplication-aware migration protocol';
  END IF;
  UPDATE greenguard_internal.tenant_ownership SET state='fenced',updated_at=clock_timestamp() WHERE tenant_id=p_tenant;
  proof:=jsonb_build_object('tenantId',p_tenant,'operationId',p_operation,'phase','source_fenced','owner','risk',
    'shardId',p_source_shard,'incarnation',p_source_incarnation,'epoch',p_source_epoch::text,'state','fenced',
    'sourceShardId',p_source_shard,'sourceIncarnation',p_source_incarnation,'sourceEpoch',p_source_epoch::text,
    'targetShardId',p_target_shard,'targetIncarnation',p_target_incarnation,'targetEpoch',p_target_epoch::text);
  INSERT INTO greenguard_internal.tenant_move_operations
    (tenant_id,operation_id,endpoint_role,source_shard_id,source_incarnation,source_epoch,target_shard_id,target_incarnation,target_epoch,state,receipt)
  VALUES(p_tenant,p_operation,'source',p_source_shard,p_source_incarnation,p_source_epoch,p_target_shard,p_target_incarnation,p_target_epoch,'source_fenced',proof);
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.fence_tenant_move_source(uuid,uuid,text,uuid,bigint,text,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.fence_tenant_move_source(uuid,uuid,text,uuid,bigint,text,uuid,bigint) TO risk_migrator;

CREATE FUNCTION greenguard_internal.abort_tenant_move_target(p_tenant uuid,p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE op greenguard_internal.tenant_move_operations%ROWTYPE; owner_row greenguard_internal.tenant_ownership%ROWTYPE; proof jsonb;
BEGIN
  SELECT * INTO op FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='target' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Risk target move operation missing'; END IF;
  IF op.state='aborted' THEN RETURN op.receipt; END IF;
  IF op.state NOT IN ('prepared','copy_verified') THEN RAISE EXCEPTION 'Risk target cannot abort after activation or terminal state'; END IF;
  SELECT * INTO owner_row FROM greenguard_internal.tenant_ownership WHERE tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND OR owner_row.shard_id<>op.target_shard_id OR owner_row.shard_incarnation<>op.target_incarnation OR
     owner_row.placement_epoch<>op.target_epoch OR owner_row.state<>'prepared' THEN
    RAISE EXCEPTION 'Risk target ownership changed before abort';
  END IF;
  PERFORM set_config('app.tenant_id',p_tenant::text,true);
  PERFORM set_config('app.shard_id',op.target_shard_id,true);
  PERFORM set_config('app.shard_incarnation',op.target_incarnation::text,true);
  PERFORM set_config('app.placement_epoch',op.target_epoch::text,true);
  PERFORM set_config('app.tenant_move_operation_id',p_operation::text,true);
  DELETE FROM public.risk_assessment_invalidations WHERE tenant_id=p_tenant;
  DELETE FROM public.risk_assessments WHERE tenant_id=p_tenant;
  DELETE FROM public.device_risk_streams WHERE tenant_id=p_tenant;
  DELETE FROM public.grain_policies WHERE tenant_id=p_tenant;
  DELETE FROM public.bin_lot_intervals WHERE tenant_id=p_tenant;
  DELETE FROM public.device_bindings WHERE tenant_id=p_tenant;
  DELETE FROM public.consumer_inbox WHERE tenant_id=p_tenant;
  DELETE FROM public.outbox_events WHERE tenant_id=p_tenant;
  DELETE FROM greenguard_internal.tenant_ownership WHERE tenant_id=p_tenant;
  proof:=jsonb_build_object('tenantId',p_tenant,'operationId',p_operation,'phase','targets_unactivated','owner','risk',
    'shardId',op.target_shard_id,'incarnation',op.target_incarnation,'epoch',op.target_epoch::text,'state','absent',
    'sourceShardId',op.source_shard_id,'sourceIncarnation',op.source_incarnation,'sourceEpoch',op.source_epoch::text,
    'targetShardId',op.target_shard_id,'targetIncarnation',op.target_incarnation,'targetEpoch',op.target_epoch::text);
  UPDATE greenguard_internal.tenant_move_operations SET state='aborted',receipt=proof,updated_at=clock_timestamp()
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='target';
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.abort_tenant_move_target(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.abort_tenant_move_target(uuid,uuid) TO risk_migrator;

CREATE FUNCTION greenguard_internal.reactivate_tenant_move_source(p_tenant uuid,p_operation uuid,p_target_abort_receipt jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE op greenguard_internal.tenant_move_operations%ROWTYPE; owner_row greenguard_internal.tenant_ownership%ROWTYPE; proof jsonb;
BEGIN
  SELECT * INTO op FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='source' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Risk source move operation missing'; END IF;
  IF op.state='source_reactivated' THEN RETURN op.receipt; END IF;
  IF op.state<>'source_fenced' THEN RAISE EXCEPTION 'Risk source is not fenced for abort'; END IF;
  IF p_target_abort_receipt IS NULL OR jsonb_typeof(p_target_abort_receipt) IS DISTINCT FROM 'object' OR
     p_target_abort_receipt->>'owner' IS DISTINCT FROM 'risk' OR p_target_abort_receipt->>'tenantId' IS DISTINCT FROM p_tenant::text OR
     p_target_abort_receipt->>'operationId' IS DISTINCT FROM p_operation::text OR
     p_target_abort_receipt->>'phase' IS DISTINCT FROM 'targets_unactivated' OR p_target_abort_receipt->>'state' IS DISTINCT FROM 'absent' OR
     p_target_abort_receipt->>'sourceShardId' IS DISTINCT FROM op.source_shard_id OR
     p_target_abort_receipt->>'sourceIncarnation' IS DISTINCT FROM op.source_incarnation::text OR
     p_target_abort_receipt->>'sourceEpoch' IS DISTINCT FROM op.source_epoch::text OR
     p_target_abort_receipt->>'targetShardId' IS DISTINCT FROM op.target_shard_id OR
     p_target_abort_receipt->>'targetIncarnation' IS DISTINCT FROM op.target_incarnation::text OR
     p_target_abort_receipt->>'targetEpoch' IS DISTINCT FROM op.target_epoch::text THEN
    RAISE EXCEPTION 'Risk source reactivation requires matching target abort receipt';
  END IF;
  SELECT * INTO owner_row FROM greenguard_internal.tenant_ownership WHERE tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND OR owner_row.shard_id<>op.source_shard_id OR owner_row.shard_incarnation<>op.source_incarnation OR
     owner_row.placement_epoch<>op.source_epoch OR owner_row.state<>'fenced' THEN
    RAISE EXCEPTION 'Risk source ownership changed before abort';
  END IF;
  UPDATE greenguard_internal.tenant_ownership SET placement_epoch=op.target_epoch,state='active',updated_at=clock_timestamp()
   WHERE tenant_id=p_tenant;
  proof:=jsonb_build_object('tenantId',p_tenant,'operationId',p_operation,'phase','source_reactivated','owner','risk',
    'shardId',op.source_shard_id,'incarnation',op.source_incarnation,'epoch',op.target_epoch::text,'state','active',
    'sourceShardId',op.source_shard_id,'sourceIncarnation',op.source_incarnation,'sourceEpoch',op.source_epoch::text,
    'targetShardId',op.target_shard_id,'targetIncarnation',op.target_incarnation,'targetEpoch',op.target_epoch::text);
  UPDATE greenguard_internal.tenant_move_operations SET state='source_reactivated',receipt=proof,updated_at=clock_timestamp()
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='source';
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.reactivate_tenant_move_source(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.reactivate_tenant_move_source(uuid,uuid,jsonb) TO risk_migrator;

-- Risk migration imports may insert into a prepared target; cleanup may delete only
-- under the same operation-bound capability and exact placement identity.
CREATE OR REPLACE FUNCTION greenguard_internal.enforce_tenant_ownership()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE row_data jsonb; row_tenant uuid; route_tenant uuid; move_operation_id uuid; op greenguard_internal.tenant_move_operations%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN row_data:=to_jsonb(OLD); ELSE row_data:=to_jsonb(NEW); END IF;
  row_tenant:=NULLIF(row_data->>'tenant_id','')::uuid;
  IF row_tenant IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)->>'tenant_id') IS DISTINCT FROM (to_jsonb(NEW)->>'tenant_id') THEN
    RAISE EXCEPTION 'tenant_id is immutable' USING ERRCODE='insufficient_privilege';
  END IF;
  route_tenant:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  IF route_tenant IS DISTINCT FROM row_tenant THEN RAISE EXCEPTION 'tenant context does not match row tenant' USING ERRCODE='insufficient_privilege'; END IF;
  IF session_user='risk_migrator' AND TG_OP IN ('INSERT','DELETE') THEN
    move_operation_id:=NULLIF(current_setting('app.tenant_move_operation_id',true),'')::uuid;
    IF move_operation_id IS NOT NULL THEN
      SELECT * INTO op FROM greenguard_internal.tenant_move_operations
       WHERE tenant_id=row_tenant AND tenant_move_operations.operation_id=move_operation_id AND endpoint_role='target'
         AND state IN ('prepared','copy_verified');
      IF FOUND AND current_setting('app.shard_id',true)=op.target_shard_id AND
         current_setting('app.shard_incarnation',true)=op.target_incarnation::text AND
         current_setting('app.placement_epoch',true)=op.target_epoch::text AND EXISTS(
           SELECT 1 FROM greenguard_internal.tenant_ownership owner_row WHERE owner_row.tenant_id=row_tenant
             AND owner_row.shard_id=op.target_shard_id AND owner_row.shard_incarnation=op.target_incarnation
             AND owner_row.placement_epoch=op.target_epoch AND owner_row.state='prepared') THEN
        IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END IF;
    END IF;
  END IF;
  PERFORM greenguard_internal.admit_tenant_placement(route_tenant,NULLIF(current_setting('app.shard_id',true),''),
    NULLIF(current_setting('app.shard_incarnation',true),'')::uuid,NULLIF(current_setting('app.placement_epoch',true),'')::bigint);
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.enforce_tenant_ownership() FROM PUBLIC;
