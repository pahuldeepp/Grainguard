-- SECURITY DEFINER coverage/maintenance routines run as projection_migrator.
-- FORCE ROW LEVEL SECURITY also applies to a table owner, so without this
-- private function context those routines silently count zero rows. Permit the
-- migration owner to cross tenants only while one of the narrow maintenance
-- routines is called through its dedicated projection_history_maintainer login.
-- The login has EXECUTE grants for these routines, but no table SELECT grant.
DO $$
DECLARE rel record;
DECLARE predicate text := 'tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid OR (current_user = ''projection_migrator'' AND session_user = ''projection_history_maintainer'')';
BEGIN
 FOR rel IN
  SELECT n.nspname,c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname=current_schema()
     AND (c.oid IN (to_regclass('reading_history'),to_regclass('sensor_reading_history'))
       OR c.oid IN (
         SELECT i.inhrelid FROM pg_inherits i
         WHERE i.inhparent IN (to_regclass('reading_history'),to_regclass('sensor_reading_history'))
       ))
     AND c.relkind IN ('r','p')
 LOOP
  EXECUTE format('ALTER POLICY tenant_isolation ON %I.%I USING (%s) WITH CHECK (%s)',
    rel.nspname,rel.relname,predicate,predicate);
 END LOOP;
END $$;

-- The partition creator is also called by the SECURITY DEFINER maintenance
-- routine. Keep newly created daily partitions under the same narrowly scoped
-- policy, including sensor-detail partitions.
CREATE OR REPLACE FUNCTION projection_history_partition(day date) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE reading_name text := 'reading_history_' || to_char(day,'YYYYMMDD');
DECLARE sensor_name text := 'sensor_reading_history_' || to_char(day,'YYYYMMDD');
DECLARE policy text := 'tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid OR (current_user = ''projection_migrator'' AND session_user = ''projection_history_maintainer'')';
BEGIN
 PERFORM pg_advisory_xact_lock(7240511);
 IF to_regclass('public.' || reading_name) IS NULL THEN
  EXECUTE format('CREATE TABLE public.%I PARTITION OF public.reading_history FOR VALUES FROM (%L) TO (%L)',reading_name,day::timestamptz,(day+1)::timestamptz);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',reading_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',reading_name);
  EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (%s) WITH CHECK (%s)',reading_name,policy,policy);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, projection_app, read_query',reading_name);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO projection_app',reading_name);
  EXECUTE format('GRANT UPDATE(inventory_enrichment) ON public.%I TO projection_app',reading_name);
 END IF;
 IF to_regclass('public.' || sensor_name) IS NULL THEN
  EXECUTE format('CREATE TABLE public.%I PARTITION OF public.sensor_reading_history FOR VALUES FROM (%L) TO (%L)',sensor_name,day::timestamptz,(day+1)::timestamptz);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',sensor_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',sensor_name);
  EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (%s) WITH CHECK (%s)',sensor_name,policy,policy);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, projection_app, read_query',sensor_name);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO projection_app',sensor_name);
 END IF;
END $$;
