-- Owner-local inventory move state. The migration role is the only role that
-- can prepare/fence/copy-verify/activate/abort a tenant in this database.
CREATE TABLE greenguard_internal.tenant_move_operations (
  tenant_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  endpoint_role text NOT NULL CHECK (endpoint_role IN ('source','target')),
  source_shard_id text NOT NULL CHECK (source_shard_id IN ('s1','s2','s3','s4')),
  source_incarnation uuid NOT NULL,
  source_epoch bigint NOT NULL CHECK (source_epoch > 0),
  target_shard_id text NOT NULL CHECK (target_shard_id IN ('s1','s2','s3','s4')),
  target_incarnation uuid NOT NULL,
  target_epoch bigint NOT NULL CHECK (target_epoch = source_epoch + 1),
  state text NOT NULL CHECK (state IN ('prepared','source_fenced','copy_verified','activated','aborted','source_reactivated')),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  preparation_receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,operation_id),
  CHECK (source_shard_id <> target_shard_id)
);
REVOKE ALL ON greenguard_internal.tenant_move_operations FROM PUBLIC;
GRANT USAGE ON SCHEMA greenguard_internal TO inventory_migrator;
-- SECURITY DEFINER source-fence checks must see only the requested tenant's
-- historical CDC rows under FORCE RLS. The owner function sets app.tenant_id
-- transaction-locally before checking history.
GRANT SELECT ON public.outbox_events, public.inventory_saga_result_outbox TO inventory_migrator;
DROP POLICY IF EXISTS inventory_migrator_move_scan ON public.outbox_events;
CREATE POLICY inventory_migrator_move_scan ON public.outbox_events
  FOR SELECT TO inventory_migrator
  USING (tenant_id::text = NULLIF(current_setting('app.tenant_id',true),''));

CREATE FUNCTION greenguard_internal.tenant_move_status(
  p_tenant uuid,p_operation uuid,p_endpoint_role text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE op greenguard_internal.tenant_move_operations%ROWTYPE;
BEGIN
  IF p_endpoint_role NOT IN ('source','target') THEN RAISE EXCEPTION 'invalid inventory move endpoint role'; END IF;
  SELECT * INTO op FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role=p_endpoint_role;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('state',op.state,'receipt',op.receipt);
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.tenant_move_status(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.tenant_move_status(uuid,uuid,text) TO inventory_migrator;

CREATE FUNCTION greenguard_internal.prepare_tenant_move_target(
  p_tenant uuid,p_operation uuid,p_source_shard text,p_source_incarnation uuid,p_source_epoch bigint,
  p_target_shard text,p_target_incarnation uuid,p_target_epoch bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE table_row record; has_rows boolean; existing greenguard_internal.tenant_move_operations%ROWTYPE; proof jsonb;
BEGIN
  IF p_tenant IS NULL OR p_operation IS NULL OR p_source_shard NOT IN ('s1','s2','s3','s4') OR
     p_target_shard NOT IN ('s1','s2','s3','s4') OR p_source_shard=p_target_shard OR
     p_source_incarnation IS NULL OR p_target_incarnation IS NULL OR p_source_epoch<=0 OR p_target_epoch<>p_source_epoch+1 THEN
    RAISE EXCEPTION 'invalid inventory tenant move target identity';
  END IF;
  SELECT * INTO existing FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation FOR UPDATE;
  IF FOUND THEN
    IF existing.endpoint_role<>'target' OR existing.source_shard_id<>p_source_shard OR
       existing.source_incarnation<>p_source_incarnation OR existing.source_epoch<>p_source_epoch OR
       existing.target_shard_id<>p_target_shard OR existing.target_incarnation<>p_target_incarnation OR
       existing.target_epoch<>p_target_epoch THEN RAISE EXCEPTION 'inventory tenant move operation identity conflict'; END IF;
    IF existing.state NOT IN ('prepared','copy_verified','activated') THEN
      RAISE EXCEPTION 'inventory target operation is in an invalid state';
    END IF;
    RETURN existing.preparation_receipt;
  END IF;
  IF EXISTS (SELECT 1 FROM greenguard_internal.tenant_ownership WHERE tenant_id=p_tenant) THEN
    RAISE EXCEPTION 'inventory target already has tenant ownership';
  END IF;
  PERFORM set_config('app.tenant_id',p_tenant::text,true);
  -- Inspect all tenant-owned relations. Future tenant tables are included in the
  -- empty-target check, while the runtime copier independently checks the exact
  -- reviewed inventory and refuses partitions.
  FOR table_row IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid
     WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attname='tenant_id'
       AND a.attnum>0 AND NOT a.attisdropped AND NOT c.relispartition
  LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE tenant_id=$1)',table_row.relname)
      INTO has_rows USING p_tenant;
    IF has_rows THEN RAISE EXCEPTION 'inventory target already contains tenant rows in %',table_row.relname; END IF;
  END LOOP;
  proof:=jsonb_build_object('tenantId',p_tenant,'operationId',p_operation,'phase','target_prepared',
    'owner','inventory','shardId',p_target_shard,'incarnation',p_target_incarnation,'epoch',p_target_epoch::text,'state','prepared',
    'sourceShardId',p_source_shard,'sourceIncarnation',p_source_incarnation,'sourceEpoch',p_source_epoch::text,
    'targetShardId',p_target_shard,'targetIncarnation',p_target_incarnation,'targetEpoch',p_target_epoch::text);
  INSERT INTO greenguard_internal.tenant_move_operations
    (tenant_id,operation_id,endpoint_role,source_shard_id,source_incarnation,source_epoch,target_shard_id,target_incarnation,target_epoch,state,receipt,preparation_receipt)
  VALUES(p_tenant,p_operation,'target',p_source_shard,p_source_incarnation,p_source_epoch,p_target_shard,p_target_incarnation,p_target_epoch,'prepared',proof,proof);
  INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state)
  VALUES(p_tenant,p_target_shard,p_target_incarnation,p_target_epoch,'prepared');
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.prepare_tenant_move_target(uuid,uuid,text,uuid,bigint,text,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.prepare_tenant_move_target(uuid,uuid,text,uuid,bigint,text,uuid,bigint) TO inventory_migrator;

CREATE FUNCTION greenguard_internal.fence_tenant_move_source(
  p_tenant uuid,p_operation uuid,p_source_shard text,p_source_incarnation uuid,p_source_epoch bigint,
  p_target_shard text,p_target_incarnation uuid,p_target_epoch bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE existing greenguard_internal.tenant_move_operations%ROWTYPE; owner_row greenguard_internal.tenant_ownership%ROWTYPE; proof jsonb;
BEGIN
  IF p_tenant IS NULL OR p_operation IS NULL OR p_source_shard NOT IN ('s1','s2','s3','s4') OR
     p_target_shard NOT IN ('s1','s2','s3','s4') OR p_source_shard=p_target_shard OR
     p_source_incarnation IS NULL OR p_target_incarnation IS NULL OR p_source_epoch<=0 OR p_target_epoch<>p_source_epoch+1 THEN
    RAISE EXCEPTION 'invalid inventory tenant move source identity';
  END IF;
  SELECT * INTO existing FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation FOR UPDATE;
  IF FOUND THEN
    IF existing.endpoint_role<>'source' OR existing.state NOT IN ('source_fenced','source_reactivated') OR
       existing.source_shard_id<>p_source_shard OR existing.source_incarnation<>p_source_incarnation OR
       existing.source_epoch<>p_source_epoch OR existing.target_shard_id<>p_target_shard OR
       existing.target_incarnation<>p_target_incarnation OR existing.target_epoch<>p_target_epoch THEN
      RAISE EXCEPTION 'inventory tenant move source operation identity conflict';
    END IF;
    RETURN existing.receipt;
  END IF;
  SELECT * INTO owner_row FROM greenguard_internal.tenant_ownership WHERE tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND OR owner_row.shard_id<>p_source_shard OR owner_row.shard_incarnation<>p_source_incarnation OR
     owner_row.placement_epoch<>p_source_epoch OR owner_row.state<>'active' THEN
    RAISE EXCEPTION 'inventory source tenant ownership does not match move';
  END IF;
  -- The ownership row lock drains runtime writers using the row-fence trigger.
  -- CDC observes inserts into outbox_events, so copying any historical event
  -- would replay external effects on the target; block until a dedup-aware
  -- outbox migration protocol exists. Pending saga outcomes are likewise unsafe.
  PERFORM set_config('app.tenant_id',p_tenant::text,true);
  IF EXISTS (SELECT 1 FROM public.outbox_events WHERE tenant_id=p_tenant) THEN
    RAISE EXCEPTION 'inventory move blocked: CDC outbox history must be migrated with a deduplication-aware protocol';
  END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_saga_result_outbox WHERE tenant_id=p_tenant AND published_at IS NULL) THEN
    RAISE EXCEPTION 'inventory move blocked: pending saga result effects must be drained';
  END IF;
  UPDATE greenguard_internal.tenant_ownership SET state='fenced',updated_at=clock_timestamp() WHERE tenant_id=p_tenant;
  proof:=jsonb_build_object('tenantId',p_tenant,'operationId',p_operation,'phase','source_fenced','owner','inventory',
    'shardId',p_source_shard,'incarnation',p_source_incarnation,'epoch',p_source_epoch::text,'state','fenced',
    'sourceShardId',p_source_shard,'sourceIncarnation',p_source_incarnation,'sourceEpoch',p_source_epoch::text,
    'targetShardId',p_target_shard,'targetIncarnation',p_target_incarnation,'targetEpoch',p_target_epoch::text);
  INSERT INTO greenguard_internal.tenant_move_operations
    (tenant_id,operation_id,endpoint_role,source_shard_id,source_incarnation,source_epoch,target_shard_id,target_incarnation,target_epoch,state,receipt)
  VALUES(p_tenant,p_operation,'source',p_source_shard,p_source_incarnation,p_source_epoch,p_target_shard,p_target_incarnation,p_target_epoch,'source_fenced',proof);
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.fence_tenant_move_source(uuid,uuid,text,uuid,bigint,text,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.fence_tenant_move_source(uuid,uuid,text,uuid,bigint,text,uuid,bigint) TO inventory_migrator;

CREATE FUNCTION greenguard_internal.record_tenant_move_copy(
  p_tenant uuid,p_operation uuid,p_source_sha256 text,p_target_sha256 text,p_row_count bigint,p_table_count integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE op greenguard_internal.tenant_move_operations%ROWTYPE; owner_row greenguard_internal.tenant_ownership%ROWTYPE;
  proof jsonb; table_row record; actual_table_count integer; actual_row_count bigint; table_rows bigint;
BEGIN
  SELECT * INTO op FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='target' FOR UPDATE;
  IF NOT FOUND OR op.state NOT IN ('prepared','copy_verified') THEN RAISE EXCEPTION 'inventory target is not prepared for copy evidence'; END IF;
  IF op.state='copy_verified' THEN RETURN op.receipt; END IF;
  SELECT * INTO owner_row FROM greenguard_internal.tenant_ownership WHERE tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND OR owner_row.shard_id<>op.target_shard_id OR owner_row.shard_incarnation<>op.target_incarnation OR
     owner_row.placement_epoch<>op.target_epoch OR owner_row.state<>'prepared' THEN
    RAISE EXCEPTION 'inventory target ownership changed before copy verification';
  END IF;
  SELECT count(*)::integer INTO actual_table_count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND a.attnum>0 AND NOT a.attisdropped);
  IF p_table_count IS DISTINCT FROM actual_table_count OR actual_table_count<>15 THEN
    RAISE EXCEPTION 'inventory copy table inventory mismatch';
  END IF;
  actual_row_count:=0;
  FOR table_row IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND a.attnum>0 AND NOT a.attisdropped)
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE tenant_id=$1',table_row.relname) INTO table_rows USING p_tenant;
    actual_row_count:=actual_row_count+table_rows;
  END LOOP;
  IF p_row_count IS DISTINCT FROM actual_row_count THEN RAISE EXCEPTION 'inventory target row count differs from copy evidence'; END IF;
  IF p_source_sha256 IS NULL OR p_target_sha256 IS NULL OR p_source_sha256 !~ '^[0-9a-f]{64}$' OR p_target_sha256 IS DISTINCT FROM p_source_sha256 OR
     p_row_count IS NULL OR p_row_count<0 OR p_table_count IS NULL OR p_table_count<=0 THEN RAISE EXCEPTION 'inventory copy evidence does not verify'; END IF;
  proof:=jsonb_build_object('tenantId',p_tenant,'operationId',p_operation,'phase','copy_verified','owner','inventory',
    'sourceShardId',op.source_shard_id,'sourceIncarnation',op.source_incarnation,'sourceEpoch',op.source_epoch::text,
    'targetShardId',op.target_shard_id,'targetIncarnation',op.target_incarnation,'targetEpoch',op.target_epoch::text,
    'sourceSha256',p_source_sha256,'targetSha256',p_target_sha256,'rowCount',p_row_count::text,'tableCount',p_table_count,
    'verifiedAt',clock_timestamp());
  UPDATE greenguard_internal.tenant_move_operations SET state='copy_verified',receipt=proof,updated_at=clock_timestamp()
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='target';
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.record_tenant_move_copy(uuid,uuid,text,text,bigint,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.record_tenant_move_copy(uuid,uuid,text,text,bigint,integer) TO inventory_migrator;

CREATE FUNCTION greenguard_internal.activate_tenant_move_target(p_tenant uuid,p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE op greenguard_internal.tenant_move_operations%ROWTYPE; owner_row greenguard_internal.tenant_ownership%ROWTYPE; proof jsonb;
BEGIN
  SELECT * INTO op FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='target' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inventory move target operation missing'; END IF;
  IF op.state='activated' THEN RETURN op.receipt; END IF;
  IF op.state<>'copy_verified' THEN RAISE EXCEPTION 'inventory target activation requires verified copy'; END IF;
  SELECT * INTO owner_row FROM greenguard_internal.tenant_ownership WHERE tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND OR owner_row.shard_id<>op.target_shard_id OR owner_row.shard_incarnation<>op.target_incarnation OR
     owner_row.placement_epoch<>op.target_epoch OR owner_row.state<>'prepared' THEN
    RAISE EXCEPTION 'inventory target ownership does not match prepared operation';
  END IF;
  UPDATE greenguard_internal.tenant_ownership SET state='active',updated_at=clock_timestamp() WHERE tenant_id=p_tenant;
  proof:=jsonb_build_object('tenantId',p_tenant,'operationId',p_operation,'phase','target_activated','owner','inventory',
    'shardId',op.target_shard_id,'incarnation',op.target_incarnation,'epoch',op.target_epoch::text,'state','active',
    'sourceShardId',op.source_shard_id,'sourceIncarnation',op.source_incarnation,'sourceEpoch',op.source_epoch::text,
    'targetShardId',op.target_shard_id,'targetIncarnation',op.target_incarnation,'targetEpoch',op.target_epoch::text,
    'sourceSha256',op.receipt->>'sourceSha256','targetSha256',op.receipt->>'targetSha256',
    'rowCount',op.receipt->>'rowCount','tableCount',op.receipt->>'tableCount','activatedAt',clock_timestamp());
  UPDATE greenguard_internal.tenant_move_operations SET state='activated',receipt=proof,updated_at=clock_timestamp()
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='target';
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.activate_tenant_move_target(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.activate_tenant_move_target(uuid,uuid) TO inventory_migrator;

CREATE FUNCTION greenguard_internal.abort_tenant_move_target(p_tenant uuid,p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE op greenguard_internal.tenant_move_operations%ROWTYPE; proof jsonb; table_name text;
BEGIN
  SELECT * INTO op FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='target' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inventory target operation missing; cannot attest it unactivated'; END IF;
  IF op.state='aborted' THEN RETURN op.receipt; END IF;
  IF op.state NOT IN ('prepared','copy_verified') THEN RAISE EXCEPTION 'inventory target can no longer be aborted'; END IF;
  PERFORM set_config('app.tenant_id',p_tenant::text,true);
  PERFORM set_config('app.shard_id',op.target_shard_id,true);
  PERFORM set_config('app.shard_incarnation',op.target_incarnation::text,true);
  PERFORM set_config('app.placement_epoch',op.target_epoch::text,true);
  PERFORM set_config('app.tenant_move_operation_id',p_operation::text,true);
  -- FK children first; inventory schema is checked against an exact reviewed
  -- 15-table inventory by the adapter before copy. New tenant tables require
  -- updating this procedure and its schema gate.
  FOREACH table_name IN ARRAY ARRAY['cable_sensors','bin_occupancies','inventory_saga_result_outbox',
    'inventory_import_state','inventory_saga_receipts','command_receipts','devices','bin_cables',
    'audit_events','outbox_events','tenant_entitlements','grain_lots','bins','sites','tenants'] LOOP
    EXECUTE format('DELETE FROM public.%I WHERE tenant_id=$1',table_name) USING p_tenant;
  END LOOP;
  DELETE FROM greenguard_internal.tenant_ownership WHERE tenant_id=p_tenant;
  proof:=jsonb_build_object('tenantId',p_tenant,'operationId',p_operation,'phase','targets_unactivated','owner','inventory',
    'shardId',op.target_shard_id,'state','absent','sourceShardId',op.source_shard_id,'sourceIncarnation',op.source_incarnation,
    'sourceEpoch',op.source_epoch::text,'targetShardId',op.target_shard_id,'targetIncarnation',op.target_incarnation,'targetEpoch',op.target_epoch::text);
  UPDATE greenguard_internal.tenant_move_operations SET state='aborted',receipt=proof,updated_at=clock_timestamp()
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='target';
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.abort_tenant_move_target(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.abort_tenant_move_target(uuid,uuid) TO inventory_migrator;

CREATE FUNCTION greenguard_internal.reactivate_tenant_move_source(p_tenant uuid,p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE op greenguard_internal.tenant_move_operations%ROWTYPE; owner_row greenguard_internal.tenant_ownership%ROWTYPE; proof jsonb;
BEGIN
  SELECT * INTO op FROM greenguard_internal.tenant_move_operations
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='source' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inventory source move operation missing'; END IF;
  IF op.state='source_reactivated' THEN RETURN op.receipt; END IF;
  IF op.state<>'source_fenced' THEN RAISE EXCEPTION 'inventory source is not fenced for abort'; END IF;
  SELECT * INTO owner_row FROM greenguard_internal.tenant_ownership WHERE tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND OR owner_row.shard_id<>op.source_shard_id OR owner_row.shard_incarnation<>op.source_incarnation OR
     owner_row.placement_epoch<>op.source_epoch OR owner_row.state<>'fenced' THEN
    RAISE EXCEPTION 'inventory source ownership changed before abort';
  END IF;
  UPDATE greenguard_internal.tenant_ownership SET placement_epoch=op.target_epoch,state='active',updated_at=clock_timestamp()
   WHERE tenant_id=p_tenant;
  proof:=jsonb_build_object('tenantId',p_tenant,'operationId',p_operation,'phase','source_reactivated','owner','inventory',
    'shardId',op.source_shard_id,'incarnation',op.source_incarnation,'epoch',op.target_epoch::text,'state','active',
    'sourceShardId',op.source_shard_id,'sourceIncarnation',op.source_incarnation,'sourceEpoch',op.source_epoch::text,
    'targetShardId',op.target_shard_id,'targetIncarnation',op.target_incarnation,'targetEpoch',op.target_epoch::text);
  UPDATE greenguard_internal.tenant_move_operations SET state='source_reactivated',receipt=proof,updated_at=clock_timestamp()
   WHERE tenant_id=p_tenant AND operation_id=p_operation AND endpoint_role='source';
  RETURN proof;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.reactivate_tenant_move_source(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.reactivate_tenant_move_source(uuid,uuid) TO inventory_migrator;

-- Permit only bound target imports and target cleanup under the migration role.
-- Runtime service roles continue to require active ownership admission.
CREATE OR REPLACE FUNCTION greenguard_internal.enforce_tenant_ownership()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE row_data jsonb; row_tenant uuid; route_tenant uuid; move_operation_id uuid;
  op greenguard_internal.tenant_move_operations%ROWTYPE; owner_row greenguard_internal.tenant_ownership%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN row_data:=to_jsonb(OLD); ELSE row_data:=to_jsonb(NEW); END IF;
  row_tenant:=NULLIF(row_data->>'tenant_id','')::uuid;
  IF row_tenant IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)->>'tenant_id') IS DISTINCT FROM (to_jsonb(NEW)->>'tenant_id') THEN
    RAISE EXCEPTION 'tenant_id is immutable' USING ERRCODE='insufficient_privilege';
  END IF;
  route_tenant:=NULLIF(current_setting('app.tenant_id',true),'')::uuid;
  IF route_tenant IS DISTINCT FROM row_tenant THEN RAISE EXCEPTION 'tenant context does not match row tenant' USING ERRCODE='insufficient_privilege'; END IF;
  IF session_user='inventory_migrator' AND TG_OP IN ('INSERT','DELETE') THEN
    move_operation_id:=NULLIF(current_setting('app.tenant_move_operation_id',true),'')::uuid;
    IF move_operation_id IS NOT NULL THEN
      SELECT * INTO op FROM greenguard_internal.tenant_move_operations
       WHERE tenant_id=row_tenant AND tenant_move_operations.operation_id=move_operation_id AND endpoint_role='target'
         AND state IN ('prepared','copy_verified') FOR SHARE;
      SELECT * INTO owner_row FROM greenguard_internal.tenant_ownership WHERE tenant_id=row_tenant;
      IF FOUND AND op.operation_id IS NOT NULL AND current_setting('app.shard_id',true)=op.target_shard_id AND
         current_setting('app.shard_incarnation',true)=op.target_incarnation::text AND
         current_setting('app.placement_epoch',true)=op.target_epoch::text AND
         owner_row.shard_id=op.target_shard_id AND owner_row.shard_incarnation=op.target_incarnation AND
         owner_row.placement_epoch=op.target_epoch AND owner_row.state='prepared' THEN
        IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END IF;
    END IF;
  END IF;
  PERFORM greenguard_internal.admit_tenant_placement(route_tenant,NULLIF(current_setting('app.shard_id',true),''),
    NULLIF(current_setting('app.shard_incarnation',true),'')::uuid,NULLIF(current_setting('app.placement_epoch',true),'')::bigint);
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.enforce_tenant_ownership() FROM PUBLIC;
