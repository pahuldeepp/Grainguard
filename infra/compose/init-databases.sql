\set ON_ERROR_STOP on
\getenv inventory_password INVENTORY_DB_PASSWORD
\getenv inventory_migrator_password INVENTORY_MIGRATOR_PASSWORD
\getenv telemetry_password TELEMETRY_DB_PASSWORD
\getenv telemetry_migrator_password TELEMETRY_MIGRATOR_PASSWORD

-- Idempotent: Postgres runs this on a fresh volume, and `make db-up` re-runs it so an
-- existing volume gains new roles and picks up rotated passwords.
-- Runtime roles never own tables and never bypass row-level security; migrators own the
-- schema objects and are used only by migrations.
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', r)
  FROM (VALUES ('inventory_app'), ('inventory_migrator'), ('telemetry_app'), ('telemetry_migrator')) AS roles(r)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE inventory_app PASSWORD :'inventory_password';
ALTER ROLE inventory_migrator PASSWORD :'inventory_migrator_password';
ALTER ROLE telemetry_app PASSWORD :'telemetry_password';
ALTER ROLE telemetry_migrator PASSWORD :'telemetry_migrator_password';

SELECT format('CREATE DATABASE %I OWNER %I', d, o)
  FROM (VALUES ('greenguard_inventory', 'inventory_migrator'), ('greenguard_telemetry', 'telemetry_migrator'), ('greenguard_read', 'postgres')) AS dbs(d, o)
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = d) \gexec
ALTER DATABASE greenguard_inventory OWNER TO inventory_migrator;
ALTER DATABASE greenguard_telemetry OWNER TO telemetry_migrator;

REVOKE ALL ON DATABASE greenguard_inventory FROM PUBLIC;
REVOKE ALL ON DATABASE greenguard_telemetry FROM PUBLIC;
REVOKE ALL ON DATABASE greenguard_read FROM PUBLIC;
GRANT CONNECT ON DATABASE greenguard_inventory TO inventory_app;
GRANT CONNECT ON DATABASE greenguard_telemetry TO telemetry_app;

\connect greenguard_inventory
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO inventory_app;
\connect greenguard_telemetry
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO telemetry_app;
