\set ON_ERROR_STOP on
\getenv projection_password PROJECTION_DB_PASSWORD
\getenv read_query_password READ_QUERY_DB_PASSWORD
\getenv read_entitlement_projector_password READ_ENTITLEMENT_PROJECTOR_PASSWORD
\getenv projection_migrator_password PROJECTION_MIGRATOR_PASSWORD
\getenv projection_history_maintainer_password PROJECTION_HISTORY_MAINTAINER_PASSWORD
\getenv cdc_password CDC_DB_PASSWORD
\getenv observability_password OBSERVABILITY_DB_PASSWORD
\getenv inventory_password INVENTORY_DB_PASSWORD
\getenv inventory_projector_password INVENTORY_PROJECTOR_PASSWORD
\getenv inventory_migrator_password INVENTORY_MIGRATOR_PASSWORD
\getenv inventory_audit_reader_password INVENTORY_AUDIT_READER_PASSWORD
\getenv telemetry_password TELEMETRY_DB_PASSWORD
\getenv telemetry_entitlement_projector_password TELEMETRY_ENTITLEMENT_PROJECTOR_PASSWORD
\getenv telemetry_migrator_password TELEMETRY_MIGRATOR_PASSWORD
\getenv risk_password RISK_DB_PASSWORD
\getenv risk_migrator_password RISK_MIGRATOR_PASSWORD

-- Non-runtime ownership import role. Only the bootstrap admin may SET ROLE;
-- owner migrations grant the narrowly scoped import function later. This does
-- not assign tenants or authorize runtime startup before trusted import.
SELECT 'CREATE ROLE tenant_ownership_bootstrap NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_ownership_bootstrap') \gexec
SELECT format('GRANT tenant_ownership_bootstrap TO %I WITH SET TRUE', current_user) \gexec

-- Idempotent: Postgres runs this on a fresh volume, and `make db-up` re-runs it so an
-- existing volume gains new roles and picks up rotated passwords.
-- Runtime roles never own tables and never bypass row-level security; migrators own the
-- schema objects and are used only by migrations.
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', r)
  FROM (VALUES ('inventory_app'), ('inventory_projector'), ('inventory_migrator'), ('inventory_audit_reader'), ('telemetry_app'), ('telemetry_entitlement_projector'), ('telemetry_migrator'), ('projection_app'), ('read_entitlement_projector'), ('projection_history_maintainer'), ('projection_migrator'), ('read_query'), ('greenguard_observer')) AS roles(r)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
SELECT 'CREATE ROLE cdc_reader' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cdc_reader') \gexec
-- RDS master users are not PostgreSQL superusers and cannot grant the native
-- REPLICATION attribute. The disposable RDS bootstrap passes -v GG_RDS=1 and
-- grants the managed rds_replication role instead. Local Compose keeps the
-- native role attribute for its self-managed PostgreSQL instance.
\if :{?GG_RDS}
ALTER ROLE cdc_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'cdc_password';
-- cdc_reader is NOINHERIT; PostgreSQL 16 grants otherwise default this membership
-- to INHERIT FALSE, leaving RDS replication privileges unavailable to Connect.
GRANT rds_replication TO cdc_reader WITH INHERIT TRUE, SET FALSE;
\else
ALTER ROLE cdc_reader LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'cdc_password';
\endif
ALTER ROLE greenguard_observer PASSWORD :'observability_password';
GRANT pg_monitor TO greenguard_observer;
ALTER ROLE inventory_app PASSWORD :'inventory_password';
ALTER ROLE inventory_projector PASSWORD :'inventory_projector_password';
ALTER ROLE inventory_migrator PASSWORD :'inventory_migrator_password';
ALTER ROLE inventory_audit_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'inventory_audit_reader_password';
ALTER ROLE telemetry_app PASSWORD :'telemetry_password';
ALTER ROLE telemetry_entitlement_projector PASSWORD :'telemetry_entitlement_projector_password';
ALTER ROLE telemetry_migrator PASSWORD :'telemetry_migrator_password';

SELECT format('CREATE DATABASE %I OWNER %I', d, o)
  FROM (VALUES ('greenguard_inventory', 'inventory_migrator'), ('greenguard_telemetry', 'telemetry_migrator'), ('greenguard_read', 'projection_migrator')) AS dbs(d, o)
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = d) \gexec
ALTER DATABASE greenguard_inventory OWNER TO inventory_migrator;
ALTER DATABASE greenguard_telemetry OWNER TO telemetry_migrator;

REVOKE ALL ON DATABASE greenguard_inventory FROM PUBLIC;
REVOKE ALL ON DATABASE greenguard_telemetry FROM PUBLIC;
REVOKE ALL ON DATABASE greenguard_read FROM PUBLIC;
GRANT CONNECT ON DATABASE greenguard_inventory TO inventory_app, inventory_projector, inventory_audit_reader, cdc_reader;
GRANT CONNECT ON DATABASE greenguard_telemetry TO telemetry_app, telemetry_entitlement_projector, cdc_reader;

\connect greenguard_inventory
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO inventory_app, inventory_projector, inventory_audit_reader;
\connect greenguard_telemetry
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO telemetry_app, telemetry_entitlement_projector;

ALTER ROLE projection_app PASSWORD :'projection_password';
ALTER ROLE read_query PASSWORD :'read_query_password';
ALTER ROLE read_entitlement_projector PASSWORD :'read_entitlement_projector_password';
ALTER ROLE projection_migrator PASSWORD :'projection_migrator_password';
ALTER ROLE projection_history_maintainer PASSWORD :'projection_history_maintainer_password';
ALTER DATABASE greenguard_read OWNER TO projection_migrator;
GRANT CONNECT ON DATABASE greenguard_read TO projection_app;
GRANT CONNECT ON DATABASE greenguard_read TO read_query;
GRANT CONNECT ON DATABASE greenguard_read TO read_entitlement_projector;
GRANT CONNECT ON DATABASE greenguard_read TO projection_history_maintainer;
\connect greenguard_read
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO projection_app;
GRANT USAGE ON SCHEMA public TO read_entitlement_projector;
GRANT USAGE ON SCHEMA public TO projection_history_maintainer;

-- Stage 06a risk-engine owner: runtime risk_app, schema owner risk_migrator.
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', r)
  FROM (VALUES ('risk_app'), ('risk_migrator')) AS roles(r)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE risk_app PASSWORD :'risk_password';
ALTER ROLE risk_migrator PASSWORD :'risk_migrator_password';
\connect postgres
SELECT 'CREATE DATABASE greenguard_risk OWNER risk_migrator'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'greenguard_risk') \gexec
ALTER DATABASE greenguard_risk OWNER TO risk_migrator;
REVOKE ALL ON DATABASE greenguard_risk FROM PUBLIC;
GRANT CONNECT ON DATABASE greenguard_risk TO risk_app, cdc_reader;
\connect greenguard_risk
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO risk_app;

-- Stage 06d jobs-worker owner (intent ledger) and notification-service owner (delivery ledger).
\getenv jobs_password JOBS_DB_PASSWORD
\getenv jobs_migrator_password JOBS_MIGRATOR_PASSWORD
\getenv notifications_password NOTIFICATIONS_DB_PASSWORD
\getenv notifications_migrator_password NOTIFICATIONS_MIGRATOR_PASSWORD
\connect postgres
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', r)
  FROM (VALUES ('jobs_app'), ('jobs_migrator'), ('notifications_app'), ('notifications_migrator')) AS roles(r)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE jobs_app PASSWORD :'jobs_password';
ALTER ROLE jobs_migrator PASSWORD :'jobs_migrator_password';
ALTER ROLE notifications_app PASSWORD :'notifications_password';
ALTER ROLE notifications_migrator PASSWORD :'notifications_migrator_password';
SELECT 'CREATE DATABASE greenguard_jobs OWNER jobs_migrator'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'greenguard_jobs') \gexec
SELECT 'CREATE DATABASE greenguard_notifications OWNER notifications_migrator'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'greenguard_notifications') \gexec
ALTER DATABASE greenguard_jobs OWNER TO jobs_migrator;
ALTER DATABASE greenguard_notifications OWNER TO notifications_migrator;
REVOKE ALL ON DATABASE greenguard_jobs FROM PUBLIC;
REVOKE ALL ON DATABASE greenguard_notifications FROM PUBLIC;
GRANT CONNECT ON DATABASE greenguard_jobs TO jobs_app;
GRANT CONNECT ON DATABASE greenguard_notifications TO notifications_app;
\connect greenguard_jobs
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO jobs_app;
\connect greenguard_notifications
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO notifications_app;

-- Stage 06b workflow-alerts owner: runtime alerts_app, schema owner alerts_migrator.
\getenv alerts_password ALERTS_DB_PASSWORD
\getenv alerts_migrator_password ALERTS_MIGRATOR_PASSWORD
\connect postgres
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', r)
  FROM (VALUES ('alerts_app'), ('alerts_migrator')) AS roles(r)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE alerts_app PASSWORD :'alerts_password';
ALTER ROLE alerts_migrator PASSWORD :'alerts_migrator_password';
SELECT 'CREATE DATABASE greenguard_alerts OWNER alerts_migrator'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'greenguard_alerts') \gexec
ALTER DATABASE greenguard_alerts OWNER TO alerts_migrator;
REVOKE ALL ON DATABASE greenguard_alerts FROM PUBLIC;
GRANT CONNECT ON DATABASE greenguard_alerts TO alerts_app, cdc_reader;
\connect greenguard_alerts
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO alerts_app;

-- Stage 07 saga authority. The runtime role cannot own tables or bypass RLS.
\getenv saga_password SAGA_DB_PASSWORD
\getenv saga_migrator_password SAGA_MIGRATOR_PASSWORD
\connect postgres
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', r)
  FROM (VALUES ('saga_app'), ('saga_migrator')) AS roles(r)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE saga_app PASSWORD :'saga_password';
ALTER ROLE saga_migrator PASSWORD :'saga_migrator_password';
SELECT 'CREATE DATABASE greenguard_sagas OWNER saga_migrator'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'greenguard_sagas') \gexec
ALTER DATABASE greenguard_sagas OWNER TO saga_migrator;
REVOKE ALL ON DATABASE greenguard_sagas FROM PUBLIC;
GRANT CONNECT ON DATABASE greenguard_sagas TO saga_app;
\connect greenguard_sagas
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO saga_app;

-- Stage 07 physical sensor hardware owner.
\getenv hardware_password HARDWARE_DB_PASSWORD
\getenv hardware_migrator_password HARDWARE_MIGRATOR_PASSWORD
\connect postgres
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', r)
  FROM (VALUES ('hardware_app'), ('hardware_migrator')) AS roles(r)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE hardware_app PASSWORD :'hardware_password';
ALTER ROLE hardware_migrator PASSWORD :'hardware_migrator_password';
SELECT 'CREATE DATABASE greenguard_hardware OWNER hardware_migrator'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'greenguard_hardware') \gexec
ALTER DATABASE greenguard_hardware OWNER TO hardware_migrator;
REVOKE ALL ON DATABASE greenguard_hardware FROM PUBLIC;
GRANT CONNECT ON DATABASE greenguard_hardware TO hardware_app;
\connect greenguard_hardware
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO hardware_app;

-- Operational shard bundles deliberately exclude central control and billing.
\if :{?GG_OPERATIONAL_ONLY}
\else
-- Hosted Dex is an optional OIDC provider for a disposable cell. Its SQL
-- identity and database are created only when the Argo values explicitly
-- enable managed Dex; objects with matching names are never adopted.
\if :{?GG_MANAGED_DEX}
\getenv dex_db_password DEX_DB_PASSWORD
\connect postgres
DO $$
DECLARE r record; d record; marker constant text := 'greenguard.managed-dex.v1';
BEGIN
  SELECT oid, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
         rolbypassrls, rolreplication, shobj_description(oid, 'pg_authid') AS comment
    INTO r FROM pg_roles WHERE rolname = 'dex_app';
  IF FOUND AND (r.comment IS DISTINCT FROM marker OR NOT r.rolcanlogin OR r.rolsuper
    OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolbypassrls OR r.rolreplication
    OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid)) THEN
    RAISE EXCEPTION 'refusing to adopt or alter foreign/elevated Dex role';
  END IF;
  SELECT db.datname, owner.rolname AS owner,
         shobj_description(db.oid, 'pg_database') AS comment
    INTO d FROM pg_database db JOIN pg_roles owner ON owner.oid = db.datdba
    WHERE db.datname = 'greenguard_dex';
  IF FOUND AND (d.comment IS DISTINCT FROM marker OR d.owner <> 'dex_app') THEN
    RAISE EXCEPTION 'refusing to adopt or take ownership of foreign Dex database';
  END IF;
END $$;
SELECT 'CREATE ROLE dex_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dex_app') \gexec
COMMENT ON ROLE dex_app IS 'greenguard.managed-dex.v1';
ALTER ROLE dex_app PASSWORD :'dex_db_password';
SELECT 'CREATE DATABASE greenguard_dex OWNER dex_app'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'greenguard_dex') \gexec
COMMENT ON DATABASE greenguard_dex IS 'greenguard.managed-dex.v1';
\endif
-- Stage 09a tenant-control-plane owner (ADR-0017): runtime control_app, schema owner
-- control_migrator. The control plane is the single writer of organizations/memberships.
\getenv control_password CONTROL_DB_PASSWORD
\getenv control_entitlement_projector_password CONTROL_ENTITLEMENT_PROJECTOR_PASSWORD
\getenv control_migrator_password CONTROL_MIGRATOR_PASSWORD
\getenv control_audit_worker_password CONTROL_AUDIT_WORKER_PASSWORD
\getenv control_bootstrap_worker_password CONTROL_BOOTSTRAP_WORKER_PASSWORD
\connect postgres
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', r)
  FROM (VALUES ('control_app'), ('control_entitlement_projector'), ('control_migrator'), ('control_audit_worker'), ('tenant_bootstrap_worker')) AS roles(r)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
SELECT 'CREATE ROLE control_bootstrap_worker_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_bootstrap_worker_role') \gexec
ALTER ROLE control_bootstrap_worker_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE control_app PASSWORD :'control_password';
ALTER ROLE control_entitlement_projector PASSWORD :'control_entitlement_projector_password';
ALTER ROLE control_migrator PASSWORD :'control_migrator_password';
ALTER ROLE control_audit_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'control_audit_worker_password';
ALTER ROLE tenant_bootstrap_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'control_bootstrap_worker_password';
GRANT control_bootstrap_worker_role TO tenant_bootstrap_worker WITH INHERIT FALSE, SET TRUE;
SELECT 'CREATE DATABASE greenguard_control OWNER control_migrator'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'greenguard_control') \gexec
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT ON DATABASE postgres TO greenguard_admin;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
ALTER DATABASE greenguard_control OWNER TO control_migrator;
REVOKE ALL ON DATABASE greenguard_control FROM PUBLIC;
GRANT CONNECT ON DATABASE greenguard_control TO control_app, control_entitlement_projector, control_audit_worker, tenant_bootstrap_worker, cdc_reader;
\connect greenguard_control
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_app;
GRANT USAGE ON SCHEMA public TO control_entitlement_projector;
GRANT USAGE ON SCHEMA public TO control_audit_worker;

-- Stage 09d billing owner: runtime billing_app, schema owner billing_migrator.
\getenv billing_password BILLING_DB_PASSWORD
\getenv billing_migrator_password BILLING_MIGRATOR_PASSWORD
\getenv billing_audit_reader_password BILLING_AUDIT_READER_PASSWORD
\connect postgres
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', r)
  FROM (VALUES ('billing_app'), ('billing_migrator'), ('billing_audit_reader')) AS roles(r)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE billing_app PASSWORD :'billing_password';
ALTER ROLE billing_migrator PASSWORD :'billing_migrator_password';
ALTER ROLE billing_audit_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'billing_audit_reader_password';
SELECT 'CREATE DATABASE greenguard_billing OWNER billing_migrator'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'greenguard_billing') \gexec
ALTER DATABASE greenguard_billing OWNER TO billing_migrator;
REVOKE ALL ON DATABASE greenguard_billing FROM PUBLIC;
GRANT CONNECT ON DATABASE greenguard_billing TO billing_app, billing_audit_reader, cdc_reader;
\connect greenguard_billing
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO billing_app;
GRANT USAGE ON SCHEMA public TO billing_audit_reader;

\endif
