-- Forward-only. Existing inbox/notifications have no certified completion
-- identity: preserve them without synthesizing sequence or source completion.
-- Missing ownership remains fail-closed until a trusted snapshot is imported.
SET lock_timeout = '2s';

-- Event workers derive placement from the durable owner row, never an event or
-- process default. This local admission is not a control-plane read lease.
CREATE FUNCTION greenguard_internal.use_projection_tenant_placement(p_tenant uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, greenguard_internal AS $$
DECLARE owner_row greenguard_internal.tenant_ownership%ROWTYPE;
BEGIN
 IF p_tenant IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'projection tenant context mismatch' USING ERRCODE='insufficient_privilege';
 END IF;
 SELECT * INTO owner_row FROM greenguard_internal.tenant_ownership WHERE tenant_id=p_tenant FOR SHARE;
 IF NOT FOUND OR owner_row.state <> 'active' THEN
  RAISE EXCEPTION 'projection placement missing or fenced' USING ERRCODE='insufficient_privilege';
 END IF;
 PERFORM set_config('app.shard_id',owner_row.shard_id,true);
 PERFORM set_config('app.shard_incarnation',owner_row.shard_incarnation::text,true);
 PERFORM set_config('app.placement_epoch',owner_row.placement_epoch::text,true);
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.use_projection_tenant_placement(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.use_projection_tenant_placement(uuid) TO projection_app;

-- No row lock: usable in the reader's read-only standby snapshot. Scope is
-- checked even though this function is the only granted access to ownership.
CREATE FUNCTION greenguard_internal.projection_ownership_snapshot(p_tenant uuid)
RETURNS TABLE(shard_id text,shard_incarnation uuid,placement_epoch bigint,state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,greenguard_internal AS $$
BEGIN
 IF p_tenant IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'projection tenant context mismatch' USING ERRCODE='insufficient_privilege';
 END IF;
 RETURN QUERY SELECT o.shard_id,o.shard_incarnation,o.placement_epoch,o.state
  FROM greenguard_internal.tenant_ownership o WHERE o.tenant_id=p_tenant;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.projection_ownership_snapshot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.projection_ownership_snapshot(uuid) TO read_query;

-- Infrastructure metadata/promotion belongs to an explicit durable bootstrap
-- identity. A restore/move must fence and replace it using its own protocol.
CREATE FUNCTION greenguard_internal.seed_projection_infrastructure_ownership(p_shard text,p_incarnation uuid,p_epoch bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE reserved uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
 INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state)
 VALUES(reserved,p_shard,p_incarnation,p_epoch,'active') ON CONFLICT(tenant_id) DO NOTHING;
 PERFORM greenguard_internal.admit_tenant_placement(reserved,p_shard,p_incarnation,p_epoch);
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.seed_projection_infrastructure_ownership(text,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.seed_projection_infrastructure_ownership(text,uuid,bigint) TO tenant_ownership_bootstrap;

-- Customer placement snapshots do not own the reserved local infrastructure
-- namespace. Reuse 000018's validated import with a trusted internal row added
-- to its working snapshot; caller-supplied reserved rows are rejected.
ALTER FUNCTION greenguard_internal.seed_tenant_ownership(jsonb,text,uuid,integer)
 RENAME TO seed_customer_ownership_including_infrastructure;
REVOKE ALL ON FUNCTION greenguard_internal.seed_customer_ownership_including_infrastructure(jsonb,text,uuid,integer) FROM PUBLIC,tenant_ownership_bootstrap;
CREATE FUNCTION greenguard_internal.seed_tenant_ownership(p_snapshot jsonb,p_local_shard_id text,p_local_incarnation uuid,p_expected_count integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE infra greenguard_internal.tenant_ownership%ROWTYPE; extra integer:=0; imported integer;
BEGIN
 IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'array' OR p_expected_count IS NULL OR p_expected_count<0 THEN
  RAISE EXCEPTION 'invalid customer ownership snapshot';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_snapshot) AS e("tenantId" uuid)
  WHERE e."tenantId"='00000000-0000-4000-8000-000000000001'::uuid) THEN
  RAISE EXCEPTION 'customer snapshot contains reserved infrastructure tenant';
 END IF;
 SELECT * INTO infra FROM greenguard_internal.tenant_ownership
  WHERE tenant_id='00000000-0000-4000-8000-000000000001'::uuid FOR SHARE;
 IF FOUND AND infra.state='active' THEN
  IF infra.shard_id IS DISTINCT FROM p_local_shard_id OR infra.shard_incarnation IS DISTINCT FROM p_local_incarnation THEN
   RAISE EXCEPTION 'customer import differs from durable infrastructure identity' USING ERRCODE='insufficient_privilege';
  END IF;
  p_snapshot:=p_snapshot||jsonb_build_array(jsonb_build_object('tenantId',infra.tenant_id,
   'shardId',infra.shard_id,'shardIncarnation',infra.shard_incarnation,'placementEpoch',infra.placement_epoch,'state','active'));
  extra:=1;
 END IF;
 imported:=greenguard_internal.seed_customer_ownership_including_infrastructure(p_snapshot,p_local_shard_id,p_local_incarnation,p_expected_count+extra);
 RETURN imported-extra;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.seed_tenant_ownership(jsonb,text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greenguard_internal.seed_tenant_ownership(jsonb,text,uuid,integer) TO tenant_ownership_bootstrap;

CREATE FUNCTION greenguard_internal.enforce_projection_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.shard_incarnation IS DISTINCT FROM NULLIF(current_setting('app.shard_incarnation',true),'')::uuid
  OR NEW.placement_epoch IS DISTINCT FROM NULLIF(current_setting('app.placement_epoch',true),'')::bigint THEN
  RAISE EXCEPTION 'projection identity does not match durable placement' USING ERRCODE='insufficient_privilege';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.enforce_projection_identity() FROM PUBLIC;

-- Notifications/completions cannot reuse a previously committed watermark.
-- xmin is used only as transaction-local evidence, never as a client token.
CREATE FUNCTION greenguard_internal.require_projection_transaction_watermark() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE matched boolean;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN
  RAISE EXCEPTION 'projection tenant context mismatch' USING ERRCODE='insufficient_privilege';
 END IF;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.projection_watermarks WHERE tenant_id=$1 AND shard_incarnation=$2 AND placement_epoch=$3 AND sequence=$4 AND xmin::text::bigint=(pg_current_xact_id()::text::numeric %% 4294967296)::bigint)',TG_TABLE_SCHEMA)
  INTO matched USING NEW.tenant_id,NEW.shard_incarnation,NEW.placement_epoch,NEW.projection_sequence;
 IF NOT matched THEN
  RAISE EXCEPTION 'projection notification/completion requires this transaction watermark' USING ERRCODE='object_not_in_prerequisite_state';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.require_projection_transaction_watermark() FROM PUBLIC;

-- Also used by forward-only version provisioning. Only the schema owner can
-- execute it; runtime roles receive narrow DML grants on the resulting tables.
CREATE FUNCTION greenguard_internal.provision_projection_watermarks(p_schema text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE saved_path text := current_setting('search_path'); t record;
BEGIN
 IF p_schema <> 'public' AND p_schema !~ '^read_v[1-9][0-9]{0,8}$' THEN
  RAISE EXCEPTION 'invalid projection schema';
 END IF;
 PERFORM set_config('search_path',format('%I,pg_catalog',p_schema),true);
 CREATE TABLE IF NOT EXISTS projection_watermarks (
  tenant_id uuid NOT NULL,
  shard_incarnation uuid NOT NULL,
  placement_epoch bigint NOT NULL CHECK(placement_epoch>=0),
  sequence bigint NOT NULL CHECK(sequence>=0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,shard_incarnation,placement_epoch));
 CREATE TABLE IF NOT EXISTS projection_event_completions (
  tenant_id uuid NOT NULL,
  consumer_name text NOT NULL,
  event_id uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  source_version bigint NOT NULL CHECK(source_version>0),
  source_event_type text NOT NULL,
  shard_incarnation uuid NOT NULL,
  placement_epoch bigint NOT NULL CHECK(placement_epoch>=0),
  projection_sequence bigint NOT NULL CHECK(projection_sequence>0),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,consumer_name,event_id),
  FOREIGN KEY(consumer_name,tenant_id,event_id) REFERENCES consumer_inbox(consumer_name,tenant_id,event_id));
 CREATE INDEX IF NOT EXISTS projection_completion_source ON projection_event_completions
  (tenant_id,aggregate_type,aggregate_id,source_version);
 ALTER TABLE projection_watermarks ENABLE ROW LEVEL SECURITY;
 ALTER TABLE projection_watermarks FORCE ROW LEVEL SECURITY;
 ALTER TABLE projection_event_completions ENABLE ROW LEVEL SECURITY;
 ALTER TABLE projection_event_completions FORCE ROW LEVEL SECURITY;
 CREATE POLICY tenant_isolation ON projection_watermarks
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
 CREATE POLICY tenant_isolation ON projection_event_completions
  USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
 REVOKE ALL ON projection_watermarks,projection_event_completions FROM PUBLIC;
 GRANT SELECT,INSERT ON projection_watermarks TO projection_app;
 GRANT UPDATE(sequence,updated_at) ON projection_watermarks TO projection_app;
 GRANT SELECT,INSERT ON projection_event_completions TO projection_app;
 GRANT SELECT ON projection_watermarks,projection_event_completions TO read_query;
 ALTER TABLE projection_notifications ADD COLUMN shard_incarnation uuid;
 ALTER TABLE projection_notifications ADD COLUMN placement_epoch bigint;
 ALTER TABLE projection_notifications ADD COLUMN projection_sequence bigint;
 -- Enforce on every new row, retain unverifiable historical rows unchanged.
 ALTER TABLE projection_notifications ADD CONSTRAINT projection_notification_watermark
  CHECK(shard_incarnation IS NOT NULL AND placement_epoch IS NOT NULL AND placement_epoch>=0
    AND projection_sequence IS NOT NULL AND projection_sequence>0) NOT VALID;
 CREATE TRIGGER projection_identity BEFORE INSERT OR UPDATE ON projection_watermarks
  FOR EACH ROW EXECUTE FUNCTION greenguard_internal.enforce_projection_identity();
 CREATE TRIGGER projection_identity BEFORE INSERT OR UPDATE ON projection_event_completions
  FOR EACH ROW EXECUTE FUNCTION greenguard_internal.enforce_projection_identity();
 CREATE TRIGGER projection_identity BEFORE INSERT OR UPDATE ON projection_notifications
  FOR EACH ROW EXECUTE FUNCTION greenguard_internal.enforce_projection_identity();
 CREATE TRIGGER projection_transaction_watermark BEFORE INSERT ON projection_notifications
  FOR EACH ROW EXECUTE FUNCTION greenguard_internal.require_projection_transaction_watermark();
 CREATE TRIGGER projection_transaction_watermark BEFORE INSERT ON projection_event_completions
  FOR EACH ROW EXECUTE FUNCTION greenguard_internal.require_projection_transaction_watermark();

 -- Migration 000018 predates versioned tables. Provisioning/promoting a schema
 -- must install fences on all tenant tables, including history partitions.
 FOR t IN SELECT c.relname,c.relispartition FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='tenant_id'
  WHERE n.nspname=p_schema AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
 LOOP
  IF NOT t.relispartition THEN
   EXECUTE format('DROP TRIGGER IF EXISTS tenant_ownership_row_fence ON %I.%I',p_schema,t.relname);
   EXECUTE format('CREATE TRIGGER tenant_ownership_row_fence BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION greenguard_internal.enforce_tenant_ownership()',p_schema,t.relname);
  END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS tenant_ownership_truncate_fence ON %I.%I',p_schema,t.relname);
  EXECUTE format('CREATE TRIGGER tenant_ownership_truncate_fence BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION greenguard_internal.forbid_tenant_truncate()',p_schema,t.relname);
  EXECUTE format('REVOKE TRUNCATE ON %I.%I FROM projection_app',p_schema,t.relname);
 END LOOP;
 IF p_schema <> 'public' THEN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO read_query',p_schema);
  EXECUTE format('CREATE TRIGGER projection_notification_outbox AFTER INSERT ON %I.projection_notifications FOR EACH ROW EXECUTE FUNCTION public.projection_notification_outbox()',p_schema);
 END IF;
 PERFORM set_config('search_path',saved_path,true);
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.provision_projection_watermarks(text) FROM PUBLIC;

-- Only durable active ownership creates an empty visibility row. Identity
-- changes create a new row; existing sequences are never reset or overwritten.
CREATE FUNCTION greenguard_internal.initialize_projection_watermarks()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE n text; saved_tenant text:=current_setting('app.tenant_id',true);
 saved_shard text:=current_setting('app.shard_id',true);
 saved_incarnation text:=current_setting('app.shard_incarnation',true);
 saved_epoch text:=current_setting('app.placement_epoch',true);
BEGIN
 IF NEW.state<>'active' THEN RETURN NEW; END IF;
 PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 PERFORM set_config('app.shard_id',NEW.shard_id,true);
 PERFORM set_config('app.shard_incarnation',NEW.shard_incarnation::text,true);
 PERFORM set_config('app.placement_epoch',NEW.placement_epoch::text,true);
 FOR n IN SELECT nspname FROM pg_namespace WHERE (nspname='public' OR nspname ~ '^read_v[1-9][0-9]{0,8}$')
  AND to_regclass(format('%I.projection_watermarks',nspname)) IS NOT NULL LOOP
  EXECUTE format('INSERT INTO %I.projection_watermarks(tenant_id,shard_incarnation,placement_epoch,sequence) VALUES($1,$2,$3,0) ON CONFLICT DO NOTHING',n)
   USING NEW.tenant_id,NEW.shard_incarnation,NEW.placement_epoch;
 END LOOP;
 PERFORM set_config('app.tenant_id',COALESCE(saved_tenant,''),true);
 PERFORM set_config('app.shard_id',COALESCE(saved_shard,''),true);
 PERFORM set_config('app.shard_incarnation',COALESCE(saved_incarnation,''),true);
 PERFORM set_config('app.placement_epoch',COALESCE(saved_epoch,''),true);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.initialize_projection_watermarks() FROM PUBLIC;
CREATE TRIGGER initialize_projection_watermarks AFTER INSERT OR UPDATE ON greenguard_internal.tenant_ownership
 FOR EACH ROW EXECUTE FUNCTION greenguard_internal.initialize_projection_watermarks();

-- Promotion preserves sequence meaning only after exact completion coverage.
-- Lock both tenant watermark rows through the swap, before testing coverage.
-- The caller must already fence writers and prove canonical view equality.
CREATE FUNCTION greenguard_internal.rebase_projection_watermarks(p_active text,p_target text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,greenguard_internal AS $$
DECLARE o record; old_sequence bigint; target_sequence bigint; missing boolean; saved_tenant text:=current_setting('app.tenant_id',true);
BEGIN
 IF (p_active<>'public' AND p_active !~ '^read_v[1-9][0-9]{0,8}$') OR p_target !~ '^read_v[1-9][0-9]{0,8}$' THEN
  RAISE EXCEPTION 'invalid projection schema';
 END IF;
 FOR o IN SELECT * FROM greenguard_internal.tenant_ownership WHERE state='active' ORDER BY tenant_id FOR SHARE LOOP
  PERFORM set_config('app.tenant_id',o.tenant_id::text,true);
  PERFORM greenguard_internal.use_projection_tenant_placement(o.tenant_id);
  EXECUTE format('SELECT sequence FROM %I.projection_watermarks WHERE tenant_id=$1 AND shard_incarnation=$2 AND placement_epoch=$3 FOR UPDATE',p_active)
   INTO STRICT old_sequence USING o.tenant_id,o.shard_incarnation,o.placement_epoch;
  EXECUTE format('SELECT sequence FROM %I.projection_watermarks WHERE tenant_id=$1 AND shard_incarnation=$2 AND placement_epoch=$3 FOR UPDATE',p_target)
   INTO STRICT target_sequence USING o.tenant_id,o.shard_incarnation,o.placement_epoch;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.projection_event_completions old WHERE old.tenant_id=$1 AND old.shard_incarnation=$2 AND old.placement_epoch=$3 AND NOT EXISTS(SELECT 1 FROM %I.projection_event_completions target WHERE target.tenant_id=old.tenant_id AND target.consumer_name=old.consumer_name AND target.event_id=old.event_id AND target.aggregate_type=old.aggregate_type AND target.aggregate_id=old.aggregate_id AND target.source_version=old.source_version AND target.source_event_type=old.source_event_type AND target.shard_incarnation=old.shard_incarnation AND target.placement_epoch=old.placement_epoch))',p_active,p_target)
   INTO missing USING o.tenant_id,o.shard_incarnation,o.placement_epoch;
  IF missing THEN RAISE EXCEPTION 'promoted projection omits committed event completion' USING ERRCODE='object_not_in_prerequisite_state'; END IF;
  EXECUTE format('UPDATE %I.projection_watermarks SET sequence=GREATEST(sequence,$4),updated_at=clock_timestamp() WHERE tenant_id=$1 AND shard_incarnation=$2 AND placement_epoch=$3',p_target)
   USING o.tenant_id,o.shard_incarnation,o.placement_epoch,old_sequence;
 END LOOP;
 PERFORM set_config('app.tenant_id',COALESCE(saved_tenant,''),true);
 IF NULLIF(saved_tenant,'') IS NOT NULL THEN PERFORM greenguard_internal.use_projection_tenant_placement(saved_tenant::uuid); END IF;
END $$;
REVOKE ALL ON FUNCTION greenguard_internal.rebase_projection_watermarks(text,text) FROM PUBLIC;

-- The publication remains on one insert-only public outbox. Active versioned
-- notifications carry their schema provenance. A trigger replaces the old
-- public-only FK with the same source-notification existence/identity check.
ALTER TABLE outbox_events ADD COLUMN projection_schema text NOT NULL DEFAULT 'public';
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_tenant_id_notification_id_fkey;
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_tenant_id_notification_id_key;
ALTER TABLE outbox_events ADD UNIQUE(tenant_id,notification_id,projection_schema);

CREATE FUNCTION validate_projection_outbox_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE matched boolean;
BEGIN
 IF NEW.projection_schema <> 'public' AND NEW.projection_schema !~ '^read_v[1-9][0-9]{0,8}$' THEN
  RAISE EXCEPTION 'invalid projection outbox schema' USING ERRCODE='foreign_key_violation';
 END IF;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.projection_notifications WHERE tenant_id=$1 AND notification_id=$2 AND shard_incarnation=$3::uuid AND placement_epoch=$4::bigint AND projection_sequence=$5::bigint)',NEW.projection_schema)
 INTO matched USING NEW.tenant_id,NEW.notification_id,NEW.payload->>'shard_incarnation',NEW.payload->>'placement_epoch',NEW.payload->>'projection_sequence';
 IF NOT matched THEN
  RAISE EXCEPTION 'projection outbox source identity missing' USING ERRCODE='foreign_key_violation';
 END IF;
 RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION validate_projection_outbox_source() FROM PUBLIC;
CREATE TRIGGER validate_projection_outbox_source BEFORE INSERT ON outbox_events
 FOR EACH ROW EXECUTE FUNCTION validate_projection_outbox_source();

CREATE OR REPLACE FUNCTION projection_notification_outbox() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE source jsonb; notification_scope text; active_version boolean;
BEGIN
 IF TG_TABLE_SCHEMA <> 'public' THEN
  SELECT EXISTS(SELECT 1 FROM pg_rewrite r JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
    JOIN pg_class c ON c.oid=d.refobjid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE r.ev_class='read.projection_watermarks'::regclass AND c.relname='projection_watermarks' AND n.nspname=TG_TABLE_SCHEMA) INTO active_version;
  IF NOT active_version THEN RETURN NEW; END IF;
 ELSE
  -- Old public workers must not publish changes after a version promotion.
  SELECT EXISTS(SELECT 1 FROM pg_rewrite r JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
    JOIN pg_class c ON c.oid=d.refobjid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE r.ev_class='read.projection_watermarks'::regclass AND c.relname='projection_watermarks' AND n.nspname='public') INTO active_version;
  IF NOT active_version AND NEW.purpose <> 'promotion_changed' THEN RETURN NEW; END IF;
 END IF;
 EXECUTE format('SELECT event FROM %I.consumer_inbox WHERE consumer_name=$1 AND tenant_id=$2 AND event_id=$3',TG_TABLE_SCHEMA)
 INTO STRICT source USING NEW.consumer_name,NEW.tenant_id,NEW.event_id;
 IF NEW.purpose='promotion_changed' THEN
  IF NEW.tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid OR source->>'event_type'<>'projection.promoted' THEN
   RAISE EXCEPTION 'invalid promotion notification';
  END IF;
  notification_scope:='epoch';
 ELSE
  notification_scope:=CASE WHEN source->>'event_type'='telemetry.recorded' THEN 'device' ELSE 'tenant' END;
 END IF;
 INSERT INTO public.outbox_events(event_id,event_type,schema_version,occurred_at,tenant_id,aggregate_type,
  aggregate_id,aggregate_version,correlation_id,causation_id,traceparent,payload,notification_id,projection_schema)
 VALUES(md5(NEW.tenant_id::text||':'||NEW.notification_id::text||':'||NEW.purpose||':'||TG_TABLE_SCHEMA||':'||NEW.shard_incarnation::text||':'||NEW.placement_epoch::text)::uuid,
  'projection.notification',1,NEW.created_at,NEW.tenant_id,'projection_notification',NEW.resource_id,
  (source->>'aggregate_version')::bigint,(source->>'correlation_id')::uuid,NEW.event_id,source->>'traceparent',
  jsonb_build_object('notification_id',NEW.notification_id,'resource_type',NEW.resource_type,'resource_id',NEW.resource_id,
   'purpose',NEW.purpose,'scope',notification_scope,'source_event_id',NEW.event_id,'source_event_type',source->>'event_type',
   'source_version',source->>'aggregate_version','shard_incarnation',NEW.shard_incarnation::text,
   'placement_epoch',NEW.placement_epoch::text,'projection_sequence',NEW.projection_sequence::text,
   'projected_at',to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
  NEW.notification_id,TG_TABLE_SCHEMA);
 RETURN NEW;
END $$;

SELECT greenguard_internal.provision_projection_watermarks('public');
DO $$ DECLARE n text; BEGIN
 FOR n IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^read_v[1-9][0-9]{0,8}$' LOOP
  PERFORM greenguard_internal.provision_projection_watermarks(n);
 END LOOP;
END $$;

-- Initialize only identities that are durably active. Preserve imported data
-- without claiming that pre-migration events have completion proof.
UPDATE greenguard_internal.tenant_ownership SET updated_at=updated_at WHERE state='active';

DO $$ DECLARE active_schema text; BEGIN
 SELECT DISTINCT n.nspname INTO STRICT active_schema FROM pg_rewrite r
  JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
  JOIN pg_class c ON c.oid=d.refobjid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE r.ev_class='read.device_views'::regclass AND c.relname='device_views' AND n.nspname<>'read';
 EXECUTE format('CREATE VIEW read.projection_watermarks WITH(security_invoker=true,security_barrier=true) AS SELECT * FROM %I.projection_watermarks',active_schema);
 EXECUTE format('CREATE VIEW read.projection_event_completions WITH(security_invoker=true,security_barrier=true) AS SELECT * FROM %I.projection_event_completions',active_schema);
END $$;
REVOKE ALL ON read.projection_watermarks,read.projection_event_completions FROM PUBLIC;
GRANT SELECT ON read.projection_watermarks,read.projection_event_completions TO read_query,projection_app;
