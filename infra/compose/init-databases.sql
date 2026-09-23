\getenv inventory_password INVENTORY_DB_PASSWORD
\getenv inventory_migrator_password INVENTORY_MIGRATOR_PASSWORD
\getenv telemetry_password TELEMETRY_DB_PASSWORD
-- Runtime roles never own tables and never bypass row-level security.
CREATE ROLE inventory_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'inventory_password';
CREATE ROLE telemetry_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'telemetry_password';
-- The migrator owns the inventory schema objects and is used only by migrations.
CREATE ROLE inventory_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'inventory_migrator_password';
CREATE DATABASE greenguard_inventory OWNER inventory_migrator;
CREATE DATABASE greenguard_telemetry;
CREATE DATABASE greenguard_read;
REVOKE ALL ON DATABASE greenguard_inventory FROM PUBLIC;
REVOKE ALL ON DATABASE greenguard_telemetry FROM PUBLIC;
REVOKE ALL ON DATABASE greenguard_read FROM PUBLIC;
GRANT CONNECT ON DATABASE greenguard_inventory TO inventory_app;
GRANT CONNECT ON DATABASE greenguard_telemetry TO telemetry_app;
\connect greenguard_inventory
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO inventory_app;
