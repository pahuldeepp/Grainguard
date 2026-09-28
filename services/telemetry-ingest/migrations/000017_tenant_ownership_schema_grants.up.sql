-- Forward-only namespace privilege hardening. Runtime data/fence function
-- grants remain narrow; unrelated roles receive no internal schema usage.
REVOKE USAGE ON SCHEMA greenguard_internal FROM PUBLIC;
DO $grant_internal_usage$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'inventory_app','inventory_projector','telemetry_app','telemetry_entitlement_projector',
    'projection_app','read_entitlement_projector','read_query','risk_app','jobs_app',
    'notifications_app','alerts_app','saga_app','hardware_app','tenant_ownership_bootstrap'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA greenguard_internal TO %I',role_name);
    END IF;
  END LOOP;
END
$grant_internal_usage$;
