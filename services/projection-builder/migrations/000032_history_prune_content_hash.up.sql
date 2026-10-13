-- Receipts use PostgreSQL's UTC JSONB manifest serialization. Old receipts fail
-- closed until the updated Cassandra verifier records a matching receipt.
CREATE OR REPLACE FUNCTION projection_history_partition_sha256(p_partition text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE row_content text;
DECLARE digest bytea := sha256(convert_to(E'greenguard-history-manifest-v2\n','UTF8'));
BEGIN
 -- Hash one serialized manifest row at a time, avoiding a partition-sized
 -- string_agg allocation. The version seed also invalidates legacy receipts.
 FOR row_content IN SELECT to_jsonb(m)::text || E'\n'
   FROM public.projection_history_cassandra_manifest(p_partition) m
   ORDER BY m.tenant_id,m.device_id,m.observed_at,m.reading_id LOOP
  digest := sha256(digest || convert_to(row_content,'UTF8'));
 END LOOP;
 RETURN encode(digest,'hex');
END $$;
REVOKE ALL ON FUNCTION projection_history_partition_sha256(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION projection_history_partition_sha256(text) TO projection_history_maintainer;

CREATE OR REPLACE FUNCTION projection_history_maintain(hot_seconds double precision, ahead integer) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' SET lock_timeout='2s' AS $$
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
DECLARE expected_sha256 text;
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
   JOIN public.projection_cassandra_history_coverage receipt
     ON receipt.partition_name=c.relname AND receipt.partition_oid=c.oid
   WHERE i.inhparent='public.reading_history'::regclass
     AND c.relname ~ '^reading_history_[0-9]{8}$'
     AND (regexp_match(pg_get_expr(c.relpartbound,c.oid), 'TO \(''([^'']+)''\)'))[1]::timestamptz <= cutoff
   ORDER BY c.relname LIMIT 32 LOOP
  BEGIN
  SELECT c.partition_oid,c.verified_rows,c.verified_sensor_rows,c.content_sha256 INTO partition_oid,expected_rows,expected_sensor_rows,expected_sha256
    FROM projection_cassandra_history_coverage c WHERE partition_name=part.relname;
  IF NOT FOUND OR partition_oid<>part.oid THEN CONTINUE; END IF;
  -- Table locks also fence administrative writes that bypass the application lock.
  EXECUTE format('LOCK TABLE public.%I IN SHARE MODE',part.relname);
  sensor_partition := replace(part.relname,'reading_history_','sensor_reading_history_');
  IF to_regclass('public.'||sensor_partition) IS NOT NULL THEN
   EXECUTE format('LOCK TABLE public.%I IN SHARE MODE',sensor_partition);
  END IF;
  IF projection_history_partition_sha256(part.relname) IS DISTINCT FROM expected_sha256 THEN CONTINUE; END IF;
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
  -- DROP holds parent-table locks until commit. Release them before scanning
  -- another manifest; the next scheduled pass starts a fresh transaction.
  EXIT;
  EXCEPTION WHEN lock_not_available THEN
   -- Keep this partition and its sensor companion; a reader or writer may
   -- still own it. Other candidates and ahead-partition creation can progress.
   CONTINUE;
  END;

 END LOOP;
END $$;

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
DECLARE verified_sha256 text;
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
  SELECT c.partition_oid,c.verified_rows,c.verified_sensor_rows,c.content_sha256 INTO verified_partition_oid,verified_rows,verified_sensor_rows,verified_sha256
    FROM public.projection_cassandra_history_coverage c WHERE c.partition_name=part.relname;
  IF NOT FOUND OR verified_partition_oid<>part.oid OR verified_rows<>actual_rows OR verified_sensor_rows<>actual_sensor_rows
     OR projection_history_partition_sha256(part.relname) IS DISTINCT FROM verified_sha256 THEN
   partition_name := part.relname;
   RETURN NEXT;
  END IF;
 END LOOP;
END $$;

