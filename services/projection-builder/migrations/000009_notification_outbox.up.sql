-- Forward-only. Stage 08 cache invalidation (ADR-0016).
-- projection_notifications keeps its invariants: immutable unique (tenant,event,purpose),
-- written in the same transaction as the projection effect. It cannot be a CDC outbox
-- as-is: it lacks the canonical envelope (event_type, schema_version, aggregate version,
-- correlation, traceparent, payload) and its event_id is the SOURCE event, not a new event
-- identity. An AFTER INSERT trigger therefore writes exactly one canonical outbox row in the
-- same transaction, so the committed notification and its event commit together.
-- Event identity is derived once from (tenant, notification, purpose); a replayed or rebuilt
-- notification produces the same event_id. The outbox is insert-only (no UPDATE/DELETE grant).
-- Scope: telemetry-driven changes invalidate one device; every other change is structural
-- and invalidates the tenant (over-invalidation is safe, under-invalidation is not).
-- Lock choice: none needed. Rows are insert-only and keyed by the notification identity.
-- Only the public (active) projection is published; versioned read_vN shadows do not
-- carry this trigger (see ADR-0016 open work on promotion).
CREATE TABLE outbox_events (
 event_id uuid NOT NULL,
 event_type text NOT NULL CHECK (event_type = 'projection.notification'),
 schema_version integer NOT NULL CHECK (schema_version = 1),
 occurred_at timestamptz NOT NULL,
 tenant_id uuid NOT NULL,
 aggregate_type text NOT NULL CHECK (aggregate_type = 'projection_notification'),
 aggregate_id uuid NOT NULL,
 aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
 correlation_id uuid NOT NULL,
 causation_id uuid NOT NULL,
 traceparent text NOT NULL,
 payload jsonb NOT NULL,
 notification_id uuid NOT NULL,
 PRIMARY KEY (tenant_id, event_id),
 UNIQUE (tenant_id, notification_id),
 FOREIGN KEY (tenant_id, notification_id) REFERENCES projection_notifications(tenant_id, notification_id));
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbox_events
 USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
 WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT INSERT ON outbox_events TO projection_app;

CREATE FUNCTION projection_notification_outbox() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
 source jsonb;
BEGIN
 SELECT event INTO STRICT source FROM consumer_inbox
  WHERE consumer_name = NEW.consumer_name AND tenant_id = NEW.tenant_id AND event_id = NEW.event_id;
 INSERT INTO outbox_events(event_id, event_type, schema_version, occurred_at, tenant_id, aggregate_type,
  aggregate_id, aggregate_version, correlation_id, causation_id, traceparent, payload, notification_id)
 VALUES (md5(NEW.tenant_id::text || ':' || NEW.notification_id::text || ':' || NEW.purpose)::uuid,
  'projection.notification', 1, NEW.created_at, NEW.tenant_id, 'projection_notification',
  NEW.resource_id, (source->>'aggregate_version')::bigint, (source->>'correlation_id')::uuid,
  NEW.event_id, source->>'traceparent',
  jsonb_build_object(
   'notification_id', NEW.notification_id,
   'resource_type', NEW.resource_type,
   'resource_id', NEW.resource_id,
   'purpose', NEW.purpose,
   'scope', CASE WHEN source->>'event_type' = 'telemetry.recorded' THEN 'device' ELSE 'tenant' END,
   'source_event_id', NEW.event_id,
   'source_event_type', source->>'event_type',
   'source_version', source->>'aggregate_version',
   'projected_at', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
  NEW.notification_id);
 RETURN NEW;
END $$;
CREATE TRIGGER projection_notification_outbox AFTER INSERT ON projection_notifications
 FOR EACH ROW EXECUTE FUNCTION projection_notification_outbox();

-- R1/H2: the replication login reads only this immutable outbox. The table stays FORCE RLS
-- for runtime roles; cdc_reader gets a SELECT-only snapshot policy, nothing else.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cdc_reader') THEN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO cdc_reader', current_database());
  GRANT USAGE ON SCHEMA public TO cdc_reader;
  GRANT SELECT ON TABLE outbox_events TO cdc_reader;
  CREATE POLICY cdc_outbox_snapshot ON outbox_events FOR SELECT TO cdc_reader USING (true);
 END IF;
END $$;
CREATE PUBLICATION greenguard_read_notifications FOR TABLE outbox_events WITH (publish = 'insert');
