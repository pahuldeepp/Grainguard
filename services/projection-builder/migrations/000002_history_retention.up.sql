-- Forward-only, data-preserving conversion; stop consumers while applying DDL.
-- Retain daily UTC partitions for a configurable hot window (default 24h, min 1h)
-- plus a 1h drop safety margin. Maintenance creates 3 days ahead by default.
-- A transaction advisory lock (7240511) serializes DDL; writers take its shared
-- form BEFORE testing the cutoff with statement_timestamp(). Existing stream /
-- latest pessimistic locks remain unchanged. Maintenance has bounded lock and
-- statement timeouts, runs only as migrator, and never grants runtime DELETE.
-- Inbox identities survive partition drops: latest and notifications reference
-- the inbox, never expiring history. No history uniqueness omits its partition key.
-- Migration copies ALL existing rows before retiring the old heap. Retention
-- starts only on the next explicit maintenance invocation, not during this copy.
BEGIN;
SET LOCAL lock_timeout = '2s';
SELECT pg_advisory_xact_lock(7240511);

ALTER TABLE consumer_inbox
 ADD COLUMN projection_device_id uuid GENERATED ALWAYS AS ((event->>'aggregate_id')::uuid) STORED,
 ADD COLUMN projection_reading_id uuid GENERATED ALWAYS AS ((event->'payload'->>'reading_id')::uuid) STORED,
 ADD CONSTRAINT inbox_reading_identity UNIQUE(consumer_name,tenant_id,event_id,projection_device_id,projection_reading_id);
-- Preserve telemetry version and reading identity invariants outside expiring partitions.
CREATE UNIQUE INDEX telemetry_version_identity ON consumer_inbox
 (consumer_name,tenant_id,projection_device_id,((event->>'aggregate_version')::bigint))
 WHERE event->>'event_type'='telemetry.recorded';
CREATE UNIQUE INDEX telemetry_reading_identity ON consumer_inbox
 (consumer_name,tenant_id,projection_reading_id) WHERE projection_reading_id IS NOT NULL;

ALTER TABLE device_latest DROP CONSTRAINT device_latest_tenant_id_device_id_reading_id_fkey;
ALTER TABLE device_latest ADD COLUMN consumer_name text NOT NULL DEFAULT 'projection-builder'
 CHECK(consumer_name='projection-builder'),
 ADD CONSTRAINT latest_inbox_reading_fk FOREIGN KEY(consumer_name,tenant_id,event_id,device_id,reading_id)
 REFERENCES consumer_inbox(consumer_name,tenant_id,event_id,projection_device_id,projection_reading_id);
ALTER TABLE projection_notifications ADD COLUMN consumer_name text NOT NULL DEFAULT 'projection-builder'
 CHECK(consumer_name='projection-builder'),
 ADD CONSTRAINT notification_inbox_fk FOREIGN KEY(consumer_name,tenant_id,event_id)
 REFERENCES consumer_inbox(consumer_name,tenant_id,event_id);

ALTER TABLE reading_history RENAME TO reading_history_unpartitioned;
ALTER INDEX reading_history_device_time RENAME TO reading_history_old_device_time;
CREATE TABLE reading_history (
 LIKE reading_history_unpartitioned INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 PRIMARY KEY(tenant_id,observed_at,reading_id)
) PARTITION BY RANGE(observed_at);
CREATE INDEX reading_history_device_time ON reading_history(tenant_id,device_id,observed_at DESC,stream_version DESC);
CREATE POLICY tenant_isolation ON reading_history
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON reading_history FROM PUBLIC, projection_app;
GRANT SELECT, INSERT ON reading_history TO projection_app;
GRANT UPDATE(inventory_enrichment) ON reading_history TO projection_app;

-- Invoker rights: no runtime DDL privilege, no SECURITY DEFINER escape hatch.
CREATE FUNCTION projection_history_partition(day date) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE partition_name text := 'reading_history_' || to_char(day,'YYYYMMDD');
BEGIN
 PERFORM pg_advisory_xact_lock(7240511);
 IF to_regclass('public.' || partition_name) IS NOT NULL THEN RETURN; END IF;
 EXECUTE format('CREATE TABLE public.%I PARTITION OF public.reading_history FOR VALUES FROM (%L) TO (%L)',
   partition_name,day::timestamptz,(day+1)::timestamptz);
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',partition_name);
 EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',partition_name);
 EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',partition_name);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, projection_app',partition_name);
 EXECUTE format('GRANT SELECT, INSERT ON public.%I TO projection_app',partition_name);
 EXECUTE format('GRANT UPDATE(inventory_enrichment) ON public.%I TO projection_app',partition_name);
END $$;
REVOKE ALL ON FUNCTION projection_history_partition(date) FROM PUBLIC;

ALTER TABLE reading_history_unpartitioned NO FORCE ROW LEVEL SECURITY;
DO $$ DECLARE day date; BEGIN
 FOR day IN SELECT DISTINCT (observed_at AT TIME ZONE 'UTC')::date FROM reading_history_unpartitioned LOOP
  PERFORM projection_history_partition(day);
 END LOOP;
END $$;
INSERT INTO reading_history SELECT * FROM reading_history_unpartitioned;
DROP TABLE reading_history_unpartitioned;
ALTER TABLE reading_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_history FORCE ROW LEVEL SECURITY;

CREATE FUNCTION projection_history_maintain(hot_seconds double precision, ahead integer) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE
 now_at timestamptz;
 cutoff timestamptz;
 day date;
 part record;
 upper_bound text[];
 dropped integer := 0;
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
 FOR part IN SELECT c.relname,pg_get_expr(c.relpartbound,c.oid) AS bounds
   FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
   WHERE i.inhparent='public.reading_history'::regclass LOOP
  upper_bound := regexp_match(part.bounds, 'TO \(''([^'']+)''\)');
  IF upper_bound IS NOT NULL AND upper_bound[1]::timestamptz <= cutoff THEN
   EXECUTE format('DROP TABLE public.%I',part.relname);
   dropped := dropped+1;
   EXIT WHEN dropped=32;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION projection_history_maintain(double precision,integer) FROM PUBLIC;
-- Seed today's hot window/ahead without pruning copied data.
DO $$ DECLARE day date; BEGIN
 FOR day IN SELECT generate_series((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date-2,
   (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date+3,interval '1 day')::date LOOP
  PERFORM projection_history_partition(day);
 END LOOP;
END $$;

-- Fail closed on missed maintenance (55000 is not quarantined). This distinguishes
-- an operational partition outage from poison-data class 23 constraint failures.
CREATE FUNCTION projection_history_accepts(observed timestamptz, hot_seconds double precision) RETURNS boolean
 LANGUAGE plpgsql SET search_path=pg_catalog,public SET timezone='UTC' AS $$
BEGIN
 IF observed < statement_timestamp()-make_interval(secs => hot_seconds) THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
    WHERE i.inhparent='public.reading_history'::regclass
      AND c.relname='reading_history_' || to_char(observed,'YYYYMMDD')) THEN
  RAISE EXCEPTION 'history partition unavailable; run maintenance' USING ERRCODE='55000';
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION projection_history_accepts(timestamptz,double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION projection_history_accepts(timestamptz,double precision) TO projection_app;

COMMIT;
