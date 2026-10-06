-- A repair can replay only the immutable canonical event retained by the
-- projection inbox. The maintenance identity receives events through this
-- narrow, time-bounded function, never direct cross-tenant inbox access.
ALTER POLICY tenant_isolation ON public.consumer_inbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid OR
    (current_user = 'projection_migrator' AND session_user = 'projection_history_maintainer'));

CREATE OR REPLACE FUNCTION projection_history_cassandra_repair_events(p_partition text, hot_seconds double precision)
RETURNS TABLE(event jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE cutoff timestamptz;
BEGIN
 IF session_user <> 'projection_history_maintainer' THEN
  RAISE EXCEPTION 'history repair requires the dedicated maintainer identity';
 END IF;
 IF p_partition IS NULL OR p_partition !~ '^reading_history_[0-9]{8}$'
    OR hot_seconds IS NULL OR NOT (hot_seconds BETWEEN 3600 AND 7776000)
    OR NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
      WHERE i.inhparent='public.reading_history'::regclass AND c.relname=p_partition) THEN
  RAISE EXCEPTION 'invalid telemetry history partition';
 END IF;
 cutoff := clock_timestamp() - make_interval(secs => hot_seconds) - interval '1 hour';
 IF NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
   WHERE i.inhparent='public.reading_history'::regclass AND c.relname=p_partition
     AND (regexp_match(pg_get_expr(c.relpartbound,c.oid), 'TO \(''([^'']+)''\)'))[1]::timestamptz <= cutoff) THEN
  RAISE EXCEPTION 'history repair is restricted to partitions outside the 24-hour window and safety margin';
 END IF;
 RETURN QUERY EXECUTE format(
  'SELECT i.event FROM public.%I r JOIN public.consumer_inbox i
     ON i.consumer_name=''projection-builder'' AND i.tenant_id=r.tenant_id AND i.event_id=r.event_id
   WHERE i.event->>''event_type''=''telemetry.recorded''
     AND i.event->''payload''->>''device_id''=r.device_id::text
     AND i.event->''payload''->>''reading_id''=r.reading_id::text
   ORDER BY r.tenant_id,r.device_id,r.observed_at,r.reading_id', p_partition);
END $$;
DROP FUNCTION IF EXISTS projection_history_cassandra_repair_events(text);
REVOKE ALL ON FUNCTION projection_history_cassandra_repair_events(text,double precision) FROM PUBLIC, projection_app, read_query;
GRANT EXECUTE ON FUNCTION projection_history_cassandra_repair_events(text,double precision) TO projection_history_maintainer;
