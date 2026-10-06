-- Cassandra's per-device Kafka offsets are not proof that every row in a
-- PostgreSQL read-history partition reached Cassandra. An isolated verifier
-- reads each aged partition against Cassandra and writes a durable receipt;
-- maintenance drops only a partition whose counts still match that receipt.
CREATE TABLE IF NOT EXISTS projection_cassandra_history_coverage (
  partition_name text PRIMARY KEY CHECK (partition_name ~ '^reading_history_[0-9]{8}$'),
  partition_oid oid NOT NULL,
  verified_rows bigint NOT NULL CHECK (verified_rows >= 0),
  verified_sensor_rows bigint NOT NULL CHECK (verified_sensor_rows >= 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON projection_cassandra_history_coverage FROM PUBLIC, projection_app, read_query;

CREATE OR REPLACE FUNCTION projection_history_cassandra_candidates(hot_seconds double precision)
RETURNS TABLE(partition_name text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE cutoff timestamptz;
DECLARE part record;
DECLARE sensor_partition text;
DECLARE actual_rows bigint;
DECLARE actual_sensor_rows bigint;
DECLARE verified_rows bigint;
DECLARE verified_sensor_rows bigint;
DECLARE verified_partition_oid oid;
BEGIN
 IF hot_seconds IS NULL OR NOT (hot_seconds BETWEEN 3600 AND 7776000) THEN
  RAISE EXCEPTION 'invalid history retention configuration';
 END IF;
 cutoff := clock_timestamp() - make_interval(secs => hot_seconds) - interval '1 hour';
 FOR part IN SELECT child.oid,child.relname::text AS relname
 FROM pg_inherits i
 JOIN pg_class child ON child.oid=i.inhrelid
 WHERE i.inhparent='public.reading_history'::regclass
   AND child.relname ~ '^reading_history_[0-9]{8}$'
   AND (regexp_match(pg_get_expr(child.relpartbound,child.oid), 'TO \(''([^'']+)''\)'))[1]::timestamptz <= cutoff
 ORDER BY child.relname LOOP
  EXECUTE format('SELECT count(*) FROM public.%I',part.relname) INTO actual_rows;
  sensor_partition := replace(part.relname,'reading_history_','sensor_reading_history_');
  IF to_regclass('public.'||sensor_partition) IS NULL THEN
   actual_sensor_rows := 0;
  ELSE
   EXECUTE format('SELECT count(*) FROM public.%I',sensor_partition) INTO actual_sensor_rows;
  END IF;
  SELECT c.partition_oid,c.verified_rows,c.verified_sensor_rows INTO verified_partition_oid,verified_rows,verified_sensor_rows
    FROM public.projection_cassandra_history_coverage c WHERE c.partition_name=part.relname;
  IF NOT FOUND OR verified_partition_oid<>part.oid OR verified_rows<>actual_rows OR verified_sensor_rows<>actual_sensor_rows THEN
   partition_name := part.relname;
   RETURN NEXT;
  END IF;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION projection_history_cassandra_manifest(p_partition text)
RETURNS TABLE(tenant_id uuid,device_id uuid,observed_at timestamptz,reading_id uuid,event_id uuid,sensor_observations jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE sensor_partition text;
DECLARE sensor_expr text;
BEGIN
 IF p_partition IS NULL OR p_partition !~ '^reading_history_[0-9]{8}$'
    OR NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
      WHERE i.inhparent='public.reading_history'::regclass AND c.relname=p_partition) THEN
  RAISE EXCEPTION 'invalid telemetry history partition';
 END IF;
 sensor_partition := replace(p_partition,'reading_history_','sensor_reading_history_');
 IF to_regclass('public.'||sensor_partition) IS NULL THEN
  sensor_expr := '''[]''::jsonb';
 ELSE
  sensor_expr := format(
   'COALESCE((SELECT jsonb_agg(jsonb_build_object(''cable_id'',s.cable_id,''layout_version'',s.layout_version,''sensor_id'',s.sensor_id,''position'',s."position",''depth_m'',s.depth_m,''metric'',s.metric,''value'',s.value,''unit'',s.unit) ORDER BY s.sensor_id,s.metric) FROM public.%I s WHERE s.tenant_id=r.tenant_id AND s.device_id=r.device_id AND s.reading_id=r.reading_id AND s.observed_at=r.observed_at),''[]''::jsonb)',
   sensor_partition);
 END IF;
 RETURN QUERY EXECUTE format(
   'SELECT r.tenant_id,r.device_id,r.observed_at,r.reading_id,r.event_id,%s FROM public.%I r ORDER BY r.tenant_id,r.device_id,r.observed_at,r.reading_id',
   sensor_expr,p_partition);
END $$;

CREATE OR REPLACE FUNCTION projection_history_partition_counts(p_partition text)
RETURNS TABLE(reading_rows bigint,sensor_rows bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE sensor_partition text;
BEGIN
 IF p_partition IS NULL OR p_partition !~ '^reading_history_[0-9]{8}$'
    OR NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
      WHERE i.inhparent='public.reading_history'::regclass AND c.relname=p_partition) THEN
  RAISE EXCEPTION 'invalid telemetry history partition';
 END IF;
 EXECUTE format('SELECT count(*) FROM public.%I',p_partition) INTO reading_rows;
 sensor_partition := replace(p_partition,'reading_history_','sensor_reading_history_');
 IF to_regclass('public.'||sensor_partition) IS NULL THEN
  sensor_rows := 0;
 ELSE
  EXECUTE format('SELECT count(*) FROM public.%I',sensor_partition) INTO sensor_rows;
 END IF;
 RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION projection_history_record_cassandra_coverage(
  p_partition text,p_rows bigint,p_sensor_rows bigint,p_sha256 text,hot_seconds double precision
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE cutoff timestamptz;
DECLARE actual_rows bigint;
DECLARE actual_sensor_rows bigint;
DECLARE sensor_partition text;
DECLARE partition_oid oid;
BEGIN
 IF p_partition IS NULL OR p_partition !~ '^reading_history_[0-9]{8}$'
    OR p_rows IS NULL OR p_rows < 0 OR p_sensor_rows IS NULL OR p_sensor_rows < 0
    OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
    OR hot_seconds IS NULL OR NOT (hot_seconds BETWEEN 3600 AND 7776000) THEN
  RAISE EXCEPTION 'invalid Cassandra coverage receipt';
 END IF;
 PERFORM pg_advisory_xact_lock(7240511);
 cutoff := clock_timestamp() - make_interval(secs => hot_seconds) - interval '1 hour';
 IF NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
   WHERE i.inhparent='public.reading_history'::regclass AND c.relname=p_partition
     AND (regexp_match(pg_get_expr(c.relpartbound,c.oid), 'TO \(''([^'']+)''\)'))[1]::timestamptz <= cutoff) THEN
  RAISE EXCEPTION 'history partition is not past the configured hot window';
 END IF;
 sensor_partition := replace(p_partition,'reading_history_','sensor_reading_history_');
 EXECUTE format('SELECT count(*) FROM public.%I',p_partition) INTO actual_rows;
 IF actual_rows <> p_rows THEN RAISE EXCEPTION 'read-history partition changed during Cassandra verification'; END IF;
 IF to_regclass('public.'||sensor_partition) IS NOT NULL THEN
  EXECUTE format('SELECT count(*) FROM public.%I',sensor_partition) INTO actual_sensor_rows;
 ELSE
  actual_sensor_rows := 0;
 END IF;
 IF actual_sensor_rows <> p_sensor_rows THEN RAISE EXCEPTION 'sensor-history partition changed during Cassandra verification'; END IF;
 SELECT c.oid INTO partition_oid FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
  WHERE i.inhparent='public.reading_history'::regclass AND c.relname=p_partition;
 IF partition_oid IS NULL THEN RAISE EXCEPTION 'telemetry history partition disappeared'; END IF;
 INSERT INTO projection_cassandra_history_coverage(partition_name,partition_oid,verified_rows,verified_sensor_rows,content_sha256,verified_at)
 VALUES(p_partition,partition_oid,p_rows,p_sensor_rows,p_sha256,clock_timestamp())
 ON CONFLICT(partition_name) DO UPDATE SET partition_oid=EXCLUDED.partition_oid,verified_rows=EXCLUDED.verified_rows,
   verified_sensor_rows=EXCLUDED.verified_sensor_rows,content_sha256=EXCLUDED.content_sha256,verified_at=EXCLUDED.verified_at;
END $$;

REVOKE ALL ON FUNCTION projection_history_cassandra_candidates(double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION projection_history_cassandra_manifest(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION projection_history_partition_counts(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION projection_history_record_cassandra_coverage(text,bigint,bigint,text,double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION projection_history_cassandra_candidates(double precision) TO projection_history_maintainer;
GRANT EXECUTE ON FUNCTION projection_history_cassandra_manifest(text) TO projection_history_maintainer;
GRANT EXECUTE ON FUNCTION projection_history_partition_counts(text) TO projection_history_maintainer;
GRANT EXECUTE ON FUNCTION projection_history_record_cassandra_coverage(text,bigint,bigint,text,double precision) TO projection_history_maintainer;

CREATE OR REPLACE FUNCTION projection_history_maintain(hot_seconds double precision, ahead integer) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE now_at timestamptz;
DECLARE cutoff timestamptz;
DECLARE day date;
DECLARE part record;
DECLARE expected_rows bigint;
DECLARE expected_sensor_rows bigint;
DECLARE actual_rows bigint;
DECLARE actual_sensor_rows bigint;
DECLARE sensor_partition text;
DECLARE partition_oid oid;
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
 FOR part IN SELECT c.oid,c.relname
   FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
   WHERE i.inhparent='public.reading_history'::regclass
     AND c.relname ~ '^reading_history_[0-9]{8}$'
     AND (regexp_match(pg_get_expr(c.relpartbound,c.oid), 'TO \(''([^'']+)''\)'))[1]::timestamptz <= cutoff
   ORDER BY c.relname LIMIT 32 LOOP
  SELECT c.partition_oid,c.verified_rows,c.verified_sensor_rows INTO partition_oid,expected_rows,expected_sensor_rows
    FROM projection_cassandra_history_coverage c WHERE partition_name=part.relname;
  IF NOT FOUND OR partition_oid<>part.oid THEN CONTINUE; END IF;
  EXECUTE format('SELECT count(*) FROM public.%I',part.relname) INTO actual_rows;
  IF actual_rows <> expected_rows THEN CONTINUE; END IF;
  sensor_partition := replace(part.relname,'reading_history_','sensor_reading_history_');
  IF to_regclass('public.'||sensor_partition) IS NOT NULL THEN
   EXECUTE format('SELECT count(*) FROM public.%I',sensor_partition) INTO actual_sensor_rows;
   IF actual_sensor_rows <> expected_sensor_rows THEN CONTINUE; END IF;
   EXECUTE format('DROP TABLE public.%I',sensor_partition);
  ELSIF expected_sensor_rows <> 0 THEN
   CONTINUE;
  END IF;
  EXECUTE format('DROP TABLE public.%I',part.relname);
 END LOOP;
END $$;
