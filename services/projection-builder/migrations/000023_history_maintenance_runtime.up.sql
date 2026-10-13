-- Expose only the bounded partition-maintenance operation to a dedicated
-- runtime login. The function remains owned by projection_migrator and its
-- fixed search_path prevents caller-controlled object resolution. The login
-- cannot create, alter, drop, or query application tables directly.
DO $maintenance_grants$
DECLARE
  target_schema name := current_schema();
BEGIN
  IF target_schema <> 'public' AND target_schema !~ '^read_v[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'unsupported projection maintenance schema';
  END IF;
  EXECUTE format('ALTER FUNCTION %I.projection_history_maintain(double precision,integer) SECURITY DEFINER', target_schema);
  EXECUTE format('ALTER FUNCTION %I.projection_history_maintain(double precision,integer) SET search_path TO pg_catalog,%I,pg_temp', target_schema, target_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.projection_history_maintain(double precision,integer) FROM PUBLIC', target_schema);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO projection_history_maintainer', target_schema);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.projection_history_maintain(double precision,integer) TO projection_history_maintainer', target_schema);
END
$maintenance_grants$;
