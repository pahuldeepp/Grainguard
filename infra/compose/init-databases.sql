\getenv inventory_password INVENTORY_DB_PASSWORD
\getenv telemetry_password TELEMETRY_DB_PASSWORD
CREATE ROLE inventory_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'inventory_password';
CREATE ROLE telemetry_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'telemetry_password';
CREATE DATABASE greenguard_inventory;
CREATE DATABASE greenguard_telemetry;
CREATE DATABASE greenguard_read;
REVOKE ALL ON DATABASE greenguard_inventory FROM PUBLIC;
REVOKE ALL ON DATABASE greenguard_telemetry FROM PUBLIC;
REVOKE ALL ON DATABASE greenguard_read FROM PUBLIC;
GRANT CONNECT ON DATABASE greenguard_inventory TO inventory_app;
GRANT CONNECT ON DATABASE greenguard_telemetry TO telemetry_app;
