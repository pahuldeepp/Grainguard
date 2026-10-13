-- Task 5: facility, sensor layout, v2 observations and policy provenance.
-- All durable effects are written with the source receipt in the same tenant
-- transaction. Snapshot/history rows retain owner version and event identity.
SET LOCAL lock_timeout = '2s';

-- Do not reinterpret v1. New scalar fields are NULL for v1 and absent v2 values.
ALTER TABLE reading_history
 ADD COLUMN schema_version smallint NOT NULL DEFAULT 1 CHECK(schema_version IN (1,2)),
 ADD COLUMN co2_ppm double precision CHECK(co2_ppm IS NULL OR co2_ppm >= 0),
 ADD COLUMN grain_moisture_percent double precision CHECK(grain_moisture_percent IS NULL OR grain_moisture_percent BETWEEN 0 AND 100);

CREATE TABLE site_views (
 consumer_name text NOT NULL DEFAULT 'projection-builder' CHECK(consumer_name='projection-builder'),
 tenant_id uuid NOT NULL,
 site_id uuid NOT NULL,
 name text NOT NULL,
 site_version bigint NOT NULL CHECK(site_version > 0),
 event_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,site_id),
 FOREIGN KEY(consumer_name,tenant_id,event_id)
   REFERENCES consumer_inbox(consumer_name,tenant_id,event_id)
);

CREATE TABLE bin_views (
 consumer_name text NOT NULL DEFAULT 'projection-builder' CHECK(consumer_name='projection-builder'),
 tenant_id uuid NOT NULL,
 bin_id uuid NOT NULL,
 site_id uuid NOT NULL,
 name text NOT NULL,
 bin_version bigint NOT NULL CHECK(bin_version > 0),
 event_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,bin_id),
 FOREIGN KEY(consumer_name,tenant_id,event_id)
   REFERENCES consumer_inbox(consumer_name,tenant_id,event_id)
);
CREATE INDEX bin_views_site ON bin_views(tenant_id,site_id,bin_id);

-- Keep every complete owner snapshot. Current state is a version-guarded view
-- over these immutable versions, so removed sensors and prior placements remain
-- available to match telemetry's captured layout_version.
CREATE TABLE cable_layout_versions (
 consumer_name text NOT NULL DEFAULT 'projection-builder' CHECK(consumer_name='projection-builder'),
 tenant_id uuid NOT NULL,
 cable_id uuid NOT NULL,
 cable_version bigint NOT NULL CHECK(cable_version > 0),
 device_id uuid NOT NULL,
 bin_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('upsert','deleted')),
 event_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,cable_id,cable_version),
 UNIQUE(tenant_id,event_id),
 FOREIGN KEY(consumer_name,tenant_id,event_id)
   REFERENCES consumer_inbox(consumer_name,tenant_id,event_id)
);
CREATE INDEX cable_layout_versions_current ON cable_layout_versions(tenant_id,cable_id,cable_version DESC);
CREATE INDEX cable_layout_versions_bin ON cable_layout_versions(tenant_id,bin_id,cable_id,cable_version DESC);

CREATE TABLE cable_layout_sensors (
 tenant_id uuid NOT NULL,
 cable_id uuid NOT NULL,
 cable_version bigint NOT NULL CHECK(cable_version > 0),
 sensor_id uuid NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 1 AND 100),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 200),
 depth_m double precision CHECK(depth_m IS NULL OR depth_m >= 0),
 PRIMARY KEY(tenant_id,cable_id,cable_version,sensor_id),
 UNIQUE(tenant_id,cable_id,cable_version,position),
 FOREIGN KEY(tenant_id,cable_id,cable_version)
   REFERENCES cable_layout_versions(tenant_id,cable_id,cable_version)
);
CREATE INDEX cable_layout_sensors_current ON cable_layout_sensors(tenant_id,cable_id,cable_version,sensor_id);

-- Sensor samples follow the same UTC hot-window policy as reading_history.
-- They are inserted only when the parent reading is inside that window.
CREATE TABLE sensor_reading_history (
 tenant_id uuid NOT NULL,
 reading_id uuid NOT NULL,
 device_id uuid NOT NULL,
 site_id uuid NOT NULL,
 bin_id uuid,
 observed_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL,
 stream_version bigint NOT NULL CHECK(stream_version > 0),
 cable_id uuid NOT NULL,
 layout_version bigint NOT NULL CHECK(layout_version > 0),
 sensor_id uuid NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 1 AND 100),
 depth_m double precision CHECK(depth_m IS NULL OR depth_m >= 0),
 metric text NOT NULL CHECK(metric IN ('temperature_c','relative_humidity_percent','co2_ppm','grain_moisture_percent')),
 value double precision NOT NULL,
 unit text NOT NULL CHECK(unit IN ('Cel','%','ppm')),
 PRIMARY KEY(tenant_id,observed_at,reading_id,sensor_id,metric),
 CHECK((metric='temperature_c' AND unit='Cel' AND value BETWEEN -80 AND 120)
    OR (metric='relative_humidity_percent' AND unit='%' AND value BETWEEN 0 AND 100)
    OR (metric='co2_ppm' AND unit='ppm' AND value >= 0)
    OR (metric='grain_moisture_percent' AND unit='%' AND value BETWEEN 0 AND 100))
) PARTITION BY RANGE(observed_at);
CREATE INDEX sensor_reading_history_bin_time ON sensor_reading_history(tenant_id,bin_id,observed_at DESC,metric);
CREATE INDEX sensor_reading_history_sensor_time ON sensor_reading_history(tenant_id,sensor_id,observed_at DESC,metric);

-- Policy snapshots are immutable by policy ID/version; only effective_to may
-- close once when an owner event identifies the superseded version.
CREATE TABLE risk_policy_versions (
 consumer_name text NOT NULL DEFAULT 'projection-builder' CHECK(consumer_name='projection-builder'),
 tenant_id uuid NOT NULL,
 policy_id uuid NOT NULL,
 policy_version bigint NOT NULL CHECK(policy_version > 0),
 grain_type text NOT NULL CHECK(grain_type ~ '^[a-z][a-z0-9_-]{0,31}$'),
 bin_id uuid,
 effective_from timestamptz NOT NULL,
 effective_to timestamptz,
 measurement_thresholds jsonb NOT NULL,
 risk_thresholds jsonb NOT NULL,
 calibrated boolean NOT NULL,
 status text NOT NULL CHECK(status IN ('draft','active')),
 provenance jsonb NOT NULL,
 calibration_evidence text,
 approved_by text,
 approved_at timestamptz,
 supersedes_policy_id uuid,
 supersedes_version bigint,
 event_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,policy_id,policy_version),
 UNIQUE(tenant_id,event_id),
 FOREIGN KEY(consumer_name,tenant_id,event_id)
   REFERENCES consumer_inbox(consumer_name,tenant_id,event_id),
 CHECK(effective_to IS NULL OR effective_to > effective_from),
 CHECK((supersedes_policy_id IS NULL) = (supersedes_version IS NULL))
);
CREATE INDEX risk_policy_effective_scope ON risk_policy_versions(tenant_id,grain_type,bin_id,effective_from DESC,policy_version DESC);
CREATE UNIQUE INDEX risk_policy_one_successor_per_predecessor
 ON risk_policy_versions(tenant_id,supersedes_policy_id,supersedes_version)
 WHERE supersedes_policy_id IS NOT NULL;

CREATE TABLE risk_assessments (
 consumer_name text NOT NULL DEFAULT 'projection-builder' CHECK(consumer_name='projection-builder'),
 tenant_id uuid NOT NULL,
 assessment_id uuid NOT NULL,
 device_id uuid NOT NULL,
 assessment_version bigint NOT NULL CHECK(assessment_version > 0),
 reading_id uuid NOT NULL,
 source_event_id uuid NOT NULL,
 bin_id uuid NOT NULL,
 lot_id uuid NOT NULL,
 grain_type text NOT NULL CHECK(grain_type ~ '^[a-z][a-z0-9_-]{0,31}$'),
 policy_id uuid,
 policy_version bigint NOT NULL CHECK(policy_version > 0),
 policy_calibrated boolean,
 policy_provenance jsonb,
 score integer CHECK(score IS NULL OR score BETWEEN 0 AND 100),
 severity text NOT NULL CHECK(severity IN ('normal','warning','critical','insufficient_data')),
 alert_eligible boolean NOT NULL,
 reasons jsonb NOT NULL,
 event_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,assessment_id),
 UNIQUE(tenant_id,event_id),
 UNIQUE(tenant_id,device_id,assessment_version),
 FOREIGN KEY(consumer_name,tenant_id,event_id)
   REFERENCES consumer_inbox(consumer_name,tenant_id,event_id)
);
CREATE INDEX risk_assessments_bin_time ON risk_assessments(tenant_id,bin_id,occurred_at DESC,assessment_version DESC);
CREATE INDEX risk_assessments_device_time ON risk_assessments(tenant_id,device_id,occurred_at DESC,assessment_version DESC);

-- A general aggregate identity/version guard covers every owner stream, not
-- only device streams. Existing device-specific uniqueness remains in place.
-- The legacy reading identity index predates non-telemetry events that may
-- reference a reading (risk.assessed). Restrict it to telemetry envelopes.
DROP INDEX telemetry_reading_identity;
CREATE UNIQUE INDEX telemetry_reading_identity ON consumer_inbox
 (consumer_name,tenant_id,projection_reading_id)
 WHERE event->>'event_type'='telemetry.recorded' AND projection_reading_id IS NOT NULL;
CREATE UNIQUE INDEX projection_aggregate_version_identity ON consumer_inbox
 (consumer_name,tenant_id,(event->>'aggregate_type'),(event->>'aggregate_id'),((event->>'aggregate_version')::bigint));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['site_views','bin_views','cable_layout_versions','cable_layout_sensors','sensor_reading_history','risk_policy_versions','risk_assessments'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, projection_app, read_query',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO projection_app',t);
 END LOOP;
END $$;
GRANT UPDATE(name,site_version,event_id,updated_at) ON site_views TO projection_app;
GRANT UPDATE(site_id,name,bin_version,event_id,updated_at) ON bin_views TO projection_app;
GRANT UPDATE(effective_to) ON risk_policy_versions TO projection_app;

-- New sensor partitions receive the same forced RLS and least-privilege grants
-- as reading_history partitions. Extend existing maintenance atomically.
CREATE OR REPLACE FUNCTION projection_history_partition(day date) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE reading_name text := 'reading_history_' || to_char(day,'YYYYMMDD');
DECLARE sensor_name text := 'sensor_reading_history_' || to_char(day,'YYYYMMDD');
BEGIN
 PERFORM pg_advisory_xact_lock(7240511);
 IF to_regclass('public.' || reading_name) IS NULL THEN
  EXECUTE format('CREATE TABLE public.%I PARTITION OF public.reading_history FOR VALUES FROM (%L) TO (%L)',reading_name,day::timestamptz,(day+1)::timestamptz);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',reading_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',reading_name);
  EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',reading_name);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, projection_app, read_query',reading_name);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO projection_app',reading_name);
  EXECUTE format('GRANT UPDATE(inventory_enrichment) ON public.%I TO projection_app',reading_name);
 END IF;
 IF to_regclass('public.' || sensor_name) IS NULL THEN
  EXECUTE format('CREATE TABLE public.%I PARTITION OF public.sensor_reading_history FOR VALUES FROM (%L) TO (%L)',sensor_name,day::timestamptz,(day+1)::timestamptz);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',sensor_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',sensor_name);
  EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',sensor_name);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, projection_app, read_query',sensor_name);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO projection_app',sensor_name);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION projection_history_maintain(hot_seconds double precision, ahead integer) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE now_at timestamptz;
DECLARE cutoff timestamptz;
DECLARE day date;
DECLARE parent_name text;
DECLARE part record;
DECLARE upper_bound text[];
DECLARE dropped integer;
BEGIN
 IF hot_seconds IS NULL OR NOT (hot_seconds BETWEEN 3600 AND 7776000)
    OR ahead IS NULL OR ahead NOT BETWEEN 1 AND 30 THEN
  RAISE EXCEPTION 'invalid history retention configuration';
 END IF;
 PERFORM pg_advisory_xact_lock(7240511);
 now_at := clock_timestamp();
 cutoff := now_at - make_interval(secs => hot_seconds) - interval '1 hour';
 FOR day IN SELECT generate_series(cutoff::date::timestamp,(now_at::date+ahead)::timestamp,interval '1 day')::date LOOP
  PERFORM projection_history_partition(day);
 END LOOP;
 FOREACH parent_name IN ARRAY ARRAY['reading_history','sensor_reading_history'] LOOP
  dropped := 0;
  FOR part IN EXECUTE format('SELECT c.relname,pg_get_expr(c.relpartbound,c.oid) AS bounds FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent=%L::regclass', 'public.'||parent_name) LOOP
   upper_bound := regexp_match(part.bounds, 'TO \(''([^'']+)''\)');
   IF upper_bound IS NOT NULL AND upper_bound[1]::timestamptz <= cutoff THEN
    EXECUTE format('DROP TABLE public.%I',part.relname);
    dropped := dropped+1;
    EXIT WHEN dropped=32;
   END IF;
  END LOOP;
 END LOOP;
END $$;

-- Provision today's and the initial ahead window before a new consumer can
-- write sensor observations. Do not invoke retention here: installing a
-- schema migration must never prune existing historical readings. The
-- scheduled maintainer applies the configured hot window before consumption.
DO $$ DECLARE day date; BEGIN
 FOR day IN SELECT generate_series((clock_timestamp() AT TIME ZONE 'UTC')::date::timestamp,
                                  ((clock_timestamp() AT TIME ZONE 'UTC')::date+3)::timestamp,
                                  interval '1 day')::date LOOP
  PERFORM projection_history_partition(day);
 END LOOP;
END $$;
