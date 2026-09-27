-- A view promotion changes the origin for every tenant. Emit one global epoch
-- notification, atomically with the route switch, instead of O(tenants) rows.
CREATE OR REPLACE FUNCTION projection_notification_outbox() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE source jsonb; notification_scope text;
BEGIN
 SELECT event INTO STRICT source FROM consumer_inbox
  WHERE consumer_name = NEW.consumer_name AND tenant_id = NEW.tenant_id AND event_id = NEW.event_id;
 IF NEW.purpose = 'promotion_changed' THEN
  IF NEW.tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid
     OR source->>'event_type' <> 'projection.promoted' THEN
   RAISE EXCEPTION 'invalid promotion notification';
  END IF;
  notification_scope := 'epoch';
 ELSE
  notification_scope := CASE WHEN source->>'event_type' = 'telemetry.recorded' THEN 'device' ELSE 'tenant' END;
 END IF;
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
   'scope', notification_scope,
   'source_event_id', NEW.event_id,
   'source_event_type', source->>'event_type',
   'source_version', source->>'aggregate_version',
   'projected_at', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
  NEW.notification_id);
 RETURN NEW;
END $$;
