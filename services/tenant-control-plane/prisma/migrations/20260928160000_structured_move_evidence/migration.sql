-- Replace caller-controlled `verified: true` flags with receipt envelopes bound to
-- the tenant, durable operation, source/target and epoch. The move controller
-- records these only after it has read the corresponding owner database state.
CREATE FUNCTION placement_move_evidence_matches(
  p_receipts jsonb, p_key text, p_tenant uuid, p_operation uuid,
  p_source text, p_target text, p_epoch bigint
) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT p_receipts->p_key->>'tenantId'=p_tenant::text AND
    p_receipts->p_key->>'operationId'=p_operation::text AND
    p_receipts->p_key->>'phase'=p_key AND
    p_receipts->p_key->>'sourceShardId'=p_source AND
    p_receipts->p_key->>'targetShardId'=p_target AND
    p_receipts->p_key->>'sourceEpoch'=p_epoch::text AND
    p_receipts->p_key->>'targetEpoch'=(p_epoch+1)::text AND
    p_receipts->p_key->>'sourceIncarnation' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    p_receipts->p_key->>'targetIncarnation' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    CASE p_key
    WHEN 'source_fenced' THEN
      p_receipts->p_key->>'phase'=p_key AND
      p_receipts->p_key->>'tenantId'=p_tenant::text AND
      p_receipts->p_key->>'operationId'=p_operation::text AND
      p_receipts->p_key->>'shardId'=p_source AND
      p_receipts->p_key->>'incarnation'=p_receipts->p_key->>'sourceIncarnation' AND
      p_receipts->p_key->>'epoch'=p_epoch::text AND
      p_receipts->p_key->>'state'='fenced'
    WHEN 'target_prepared' THEN
      p_receipts->p_key->>'phase'=p_key AND
      p_receipts->p_key->>'tenantId'=p_tenant::text AND
      p_receipts->p_key->>'operationId'=p_operation::text AND
      p_receipts->p_key->>'shardId'=p_target AND
      p_receipts->p_key->>'incarnation'=p_receipts->p_key->>'targetIncarnation' AND
      p_receipts->p_key->>'epoch'=(p_epoch+1)::text AND
      p_receipts->p_key->>'state'='prepared'
    WHEN 'copy_verified' THEN
      p_receipts->p_key->>'phase'=p_key AND
      p_receipts->p_key->>'tenantId'=p_tenant::text AND
      p_receipts->p_key->>'operationId'=p_operation::text AND
      p_receipts->p_key->>'sourceSha256' ~ '^[0-9a-f]{64}$' AND
      p_receipts->p_key->>'sourceSha256'=p_receipts->p_key->>'targetSha256' AND
      p_receipts->p_key->>'rowCount' ~ '^[0-9]+$' AND
      (p_receipts->p_key->>'tableCount') ~ '^[1-9][0-9]*$'
    WHEN 'target_activated' THEN
      p_receipts->p_key->>'phase'=p_key AND
      p_receipts->p_key->>'tenantId'=p_tenant::text AND
      p_receipts->p_key->>'operationId'=p_operation::text AND
      p_receipts->p_key->>'shardId'=p_target AND
      p_receipts->p_key->>'incarnation'=p_receipts->p_key->>'targetIncarnation' AND
      p_receipts->p_key->>'epoch'=(p_epoch+1)::text AND
      p_receipts->p_key->>'state'='active'
    WHEN 'targets_unactivated' THEN
      p_receipts->p_key->>'phase'=p_key AND
      p_receipts->p_key->>'tenantId'=p_tenant::text AND
      p_receipts->p_key->>'operationId'=p_operation::text AND
      p_receipts->p_key->>'shardId'=p_target AND
      p_receipts->p_key->>'incarnation'=p_receipts->p_key->>'targetIncarnation' AND
      p_receipts->p_key->>'state'='absent'
    WHEN 'source_reactivated' THEN
      p_receipts->p_key->>'phase'=p_key AND
      p_receipts->p_key->>'tenantId'=p_tenant::text AND
      p_receipts->p_key->>'operationId'=p_operation::text AND
      p_receipts->p_key->>'shardId'=p_source AND
      p_receipts->p_key->>'incarnation'=p_receipts->p_key->>'sourceIncarnation' AND
      p_receipts->p_key->>'epoch'=(p_epoch+1)::text AND
      p_receipts->p_key->>'state'='active'
    WHEN 'baseline_copied' THEN
      p_receipts->p_key->>'phase'=p_key AND
      p_receipts->p_key->>'tenantId'=p_tenant::text AND
      p_receipts->p_key->>'operationId'=p_operation::text AND
      p_receipts->p_key->>'sourceSha256' ~ '^[0-9a-f]{64}$' AND
      p_receipts->p_key->>'sourceSha256'=p_receipts->p_key->>'targetSha256' AND
      p_receipts->p_key->>'rowCount' ~ '^[0-9]+$'
    ELSE false
  END
$$;
REVOKE ALL ON FUNCTION placement_move_evidence_matches(jsonb,text,uuid,uuid,text,text,bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION enforce_placement_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.routing_epoch < OLD.routing_epoch OR
     (NEW.shard_id <> OLD.shard_id AND NEW.routing_epoch <= OLD.routing_epoch) THEN
    RAISE EXCEPTION 'placement epoch must advance when ownership changes';
  END IF;
  IF NEW.shard_id <> OLD.shard_id AND NOT EXISTS (
    SELECT 1 FROM placement_moves m
     WHERE m.tenant_id=OLD.tenant_id AND m.source_shard_id=OLD.shard_id
       AND m.target_shard_id=NEW.shard_id AND m.expected_epoch=OLD.routing_epoch
       AND m.resulting_epoch=NEW.routing_epoch AND m.state='switched'
       AND placement_move_evidence_matches(m.receipts,'source_fenced',m.tenant_id,m.operation_id,m.source_shard_id,m.target_shard_id,m.expected_epoch)
       AND placement_move_evidence_matches(m.receipts,'target_prepared',m.tenant_id,m.operation_id,m.source_shard_id,m.target_shard_id,m.expected_epoch)
       AND placement_move_evidence_matches(m.receipts,'copy_verified',m.tenant_id,m.operation_id,m.source_shard_id,m.target_shard_id,m.expected_epoch)
  ) THEN
    RAISE EXCEPTION 'ownership change requires a matching switched move receipt';
  END IF;
  IF current_user='control_app' AND
    (NEW.routing_epoch<>OLD.routing_epoch OR NEW.placement_state<>OLD.placement_state) AND NOT EXISTS (
      SELECT 1 FROM placement_moves m WHERE m.tenant_id=OLD.tenant_id AND (
        (NEW.placement_state='quiescing' AND OLD.placement_state='active' AND NEW.routing_epoch=OLD.routing_epoch
          AND m.state='quiescing' AND m.source_shard_id=OLD.shard_id AND m.expected_epoch=OLD.routing_epoch)
        OR (NEW.placement_state='activating' AND OLD.placement_state='quiescing' AND m.state='switched' AND m.resulting_epoch=NEW.routing_epoch
          AND m.expected_epoch=OLD.routing_epoch AND m.source_shard_id=OLD.shard_id AND m.target_shard_id=NEW.shard_id)
        OR (NEW.placement_state='active' AND OLD.placement_state='activating' AND NEW.routing_epoch=OLD.routing_epoch
          AND m.state='completed' AND m.target_shard_id=NEW.shard_id AND m.resulting_epoch=NEW.routing_epoch
          AND placement_move_evidence_matches(m.receipts,'target_activated',m.tenant_id,m.operation_id,m.source_shard_id,m.target_shard_id,m.expected_epoch))
        OR (NEW.placement_state='active' AND OLD.placement_state IN ('active','quiescing')
          AND NEW.shard_id=OLD.shard_id AND NEW.routing_epoch>OLD.routing_epoch AND m.state='aborted'
          AND m.source_shard_id=OLD.shard_id AND m.expected_epoch=OLD.routing_epoch AND m.resulting_epoch=NEW.routing_epoch
          AND placement_move_evidence_matches(m.receipts,'targets_unactivated',m.tenant_id,m.operation_id,m.source_shard_id,m.target_shard_id,m.expected_epoch)
          AND placement_move_evidence_matches(m.receipts,'source_reactivated',m.tenant_id,m.operation_id,m.source_shard_id,m.target_shard_id,m.expected_epoch))
      )
  ) THEN
    RAISE EXCEPTION 'placement transition requires a matching durable move';
  END IF;
  RETURN NEW;
END $$;
GRANT EXECUTE ON FUNCTION placement_move_evidence_matches(jsonb,text,uuid,uuid,text,text,bigint) TO control_app;
