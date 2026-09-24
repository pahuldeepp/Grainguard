-- Forward-only. Lock order: inbox unique key -> inventory projection_streams FOR UPDATE
-- -> telemetry projection_streams FOR UPDATE (telemetry only) ->
-- stream_gaps -> device_latest FOR UPDATE. SET LOCAL lock_timeout bounds waits.
-- projection_streams is the insert-if-absent lock anchor even before inventory exists.
-- consumer_inbox: immutable unique identity, JSONB semantic collision comparison.
-- reading_history: insert-only identities; enrichment flag may advance to applied.
-- device_views: version-guarded upsert, partial events folded in contiguous order.
-- device_latest: pessimistic device lock, deterministic (observed_at, version) max.
-- stream_gaps: pessimistic stream lock; closed ranges retained (no DELETE grant).
-- projection_notifications: immutable unique (tenant,event,purpose), relay may mark delivered.
-- projection_checkpoints: monotonic offset upsert under group ownership. Infrastructure
-- barriers use reserved tenant 00000000-0000-4000-8000-000000000001, never a customer.
CREATE TABLE consumer_inbox (
 consumer_name text NOT NULL, tenant_id uuid NOT NULL, event_id uuid NOT NULL,
 source_topic text NOT NULL, source_partition integer NOT NULL, source_offset bigint NOT NULL,
 event jsonb NOT NULL, processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (consumer_name,tenant_id,event_id));
CREATE INDEX inbox_device_versions ON consumer_inbox
 (tenant_id, (event->>'aggregate_id'), ((event->>'aggregate_version')::bigint));
CREATE TABLE projection_streams (
 tenant_id uuid NOT NULL, device_id uuid NOT NULL, stream text NOT NULL CHECK(stream IN ('inventory','telemetry')),
 max_seen_version bigint NOT NULL DEFAULT 0, contiguous_through_version bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,device_id,stream));
CREATE TABLE device_views (
 tenant_id uuid NOT NULL, device_id uuid NOT NULL, site_id uuid NOT NULL, bin_id uuid,
 serial_number text NOT NULL, status text NOT NULL, inventory_version bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,device_id));
CREATE TABLE reading_history (
 tenant_id uuid NOT NULL, reading_id uuid NOT NULL, device_id uuid NOT NULL, event_id uuid NOT NULL,
 stream_version bigint NOT NULL, source_message_id text NOT NULL, site_id uuid NOT NULL, bin_id uuid,
 observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL,
 temperature_c double precision, relative_humidity_percent double precision,
 inventory_enrichment text NOT NULL CHECK(inventory_enrichment IN ('pending','applied')),
 projected_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,reading_id),
 UNIQUE(tenant_id,event_id), UNIQUE(tenant_id,device_id,stream_version),
 UNIQUE(tenant_id,device_id,reading_id));
CREATE INDEX reading_history_device_time ON reading_history(tenant_id,device_id,observed_at DESC,stream_version DESC);
CREATE TABLE device_latest (
 tenant_id uuid NOT NULL, device_id uuid NOT NULL, reading_id uuid NOT NULL, event_id uuid NOT NULL,
 selected_observed_at timestamptz NOT NULL, selected_stream_version bigint NOT NULL,
 max_seen_stream_version bigint NOT NULL, contiguous_through_version bigint NOT NULL,
 projected_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,device_id),
 FOREIGN KEY(tenant_id,device_id,reading_id) REFERENCES reading_history(tenant_id,device_id,reading_id));
CREATE TABLE stream_gaps (
 tenant_id uuid NOT NULL, device_id uuid NOT NULL, stream text NOT NULL,
 from_version bigint NOT NULL, to_version bigint NOT NULL, detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 closed_at timestamptz, PRIMARY KEY(tenant_id,device_id,stream,from_version),
 CHECK(from_version<=to_version), FOREIGN KEY(tenant_id,device_id,stream) REFERENCES projection_streams(tenant_id,device_id,stream));
CREATE INDEX stream_gaps_open ON stream_gaps(tenant_id,device_id,stream,from_version) WHERE closed_at IS NULL;
CREATE TABLE projection_notifications (
 tenant_id uuid NOT NULL, notification_id uuid NOT NULL, resource_type text NOT NULL,
 resource_id uuid NOT NULL, event_id uuid NOT NULL, purpose text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivered_at timestamptz,
 PRIMARY KEY(tenant_id,notification_id), UNIQUE(tenant_id,event_id,purpose));
CREATE TABLE projection_checkpoints (
 tenant_id uuid NOT NULL, consumer_name text NOT NULL, topic text NOT NULL, partition integer NOT NULL,
 committed_offset bigint NOT NULL, last_event_occurred_at timestamptz,
 last_projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 source_time timestamptz, source_position numeric(20), raw_position bigint, partition_count integer,
 PRIMARY KEY(tenant_id,consumer_name,topic,partition));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['consumer_inbox','projection_streams','device_views','reading_history','device_latest','stream_gaps','projection_notifications','projection_checkpoints'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT, INSERT ON %I TO projection_app',t);
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO projection_app;
GRANT UPDATE(max_seen_version,contiguous_through_version) ON projection_streams TO projection_app;
GRANT UPDATE(site_id,bin_id,serial_number,status,inventory_version,updated_at) ON device_views TO projection_app;
GRANT UPDATE(inventory_enrichment) ON reading_history TO projection_app;
GRANT UPDATE(reading_id,event_id,selected_observed_at,selected_stream_version,max_seen_stream_version,contiguous_through_version,projected_at) ON device_latest TO projection_app;
GRANT UPDATE(to_version,closed_at) ON stream_gaps TO projection_app;
GRANT UPDATE(delivered_at) ON projection_notifications TO projection_app;
GRANT UPDATE(committed_offset,last_event_occurred_at,last_projected_at,source_time,source_position,raw_position,partition_count) ON projection_checkpoints TO projection_app;

CREATE UNIQUE INDEX inventory_version_identity ON consumer_inbox(consumer_name,tenant_id,(event->>'aggregate_id'),((event->>'aggregate_version')::bigint)) WHERE event->>'aggregate_type'='device';
