-- Legacy repair function retained to match the already-applied disposable
-- migration 30. Migration 31 replaces it with the configured hot-window form.
ALTER POLICY tenant_isolation ON public.consumer_inbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid OR
    (current_user = 'projection_migrator' AND session_user = 'projection_history_maintainer'));

CREATE OR REPLACE FUNCTION projection_history_cassandra_repair_events(p_partition text)
RETURNS TABLE(event jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE cutoff timestamptz;
BEGIN
 IF session_user <> 'projection_history_maintainer' THEN
  RAISE EXCEPTION 'history repair requires the dedicated maintainer identity';
 END IF;
 IF p_partition IS NULL OR p_partition !~ '^reading_history_[0-9]{8}$'
    OR NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
      WHERE i.inhparent='public.reading_history'::regclass AND c.relname=p_partition) THEN
  RAISE EXCEPTION 'invalid telemetry history partition';
 END IF;
 cutoff := clock_timestamp() - interval '25 hours';
 IF NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
   WHERE i.inhparent='public.reading_history'::regclass AND c.relname=p_partition
     AND (regexp_match(pg_get_expr(c.relpartbound,c.oid), 'TO \\(''([^'']+)''\\)'))[1]::timestamptz <= cutoff) THEN
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
REVOKE ALL ON FUNCTION projection_history_cassandra_repair_events(text) FROM PUBLIC, projection_app, read_query;
GRANT EXECUTE ON FUNCTION projection_history_cassandra_repair_events(text) TO projection_history_maintainer;
