\set ON_ERROR_STOP on

-- This small follow-up Job runs only for an operational shard, after
-- init-databases.sql has created all owner databases and the NOLOGIN group.
\getenv tenant_bootstrap_password TENANT_BOOTSTRAP_PASSWORD
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', :'gg_tenant_bootstrap_role')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'gg_tenant_bootstrap_role') \gexec
ALTER ROLE :"gg_tenant_bootstrap_role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'tenant_bootstrap_password';
GRANT tenant_ownership_bootstrap TO :"gg_tenant_bootstrap_role" WITH INHERIT FALSE, SET TRUE;

-- PostgreSQL grants CONNECT on postgres/template1 to PUBLIC by default. Remove
-- that ambient access so this login reaches only the explicit owner DB list.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT ON DATABASE postgres TO greenguard_admin;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
GRANT CONNECT ON DATABASE greenguard_telemetry TO :"gg_tenant_bootstrap_role";
GRANT CONNECT ON DATABASE greenguard_read TO :"gg_tenant_bootstrap_role";
GRANT CONNECT ON DATABASE greenguard_jobs TO :"gg_tenant_bootstrap_role";
GRANT CONNECT ON DATABASE greenguard_sagas TO :"gg_tenant_bootstrap_role";
GRANT CONNECT ON DATABASE greenguard_hardware TO :"gg_tenant_bootstrap_role";
GRANT CONNECT ON DATABASE greenguard_inventory TO :"gg_tenant_bootstrap_role";
GRANT CONNECT ON DATABASE greenguard_alerts TO :"gg_tenant_bootstrap_role";
GRANT CONNECT ON DATABASE greenguard_risk TO :"gg_tenant_bootstrap_role";
GRANT CONNECT ON DATABASE greenguard_notifications TO :"gg_tenant_bootstrap_role";
