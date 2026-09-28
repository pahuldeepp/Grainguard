\set ON_ERROR_STOP on
\set GG_OPERATIONAL_ONLY true
\include /bootstrap/init-databases.sql
\connect postgres
\getenv replication_password GG_REPLICATION_PASSWORD
\getenv shard_id GG_SHARD_ID
SELECT 'CREATE ROLE gg_replicator LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gg_replicator') \gexec
ALTER ROLE gg_replicator PASSWORD :'replication_password';
SELECT pg_create_physical_replication_slot('gg_replica')
 WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'gg_replica');
CREATE TABLE IF NOT EXISTS public.greenguard_shard_identity (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 shard_id text NOT NULL CHECK (shard_id IN ('s1','s2','s3','s4'))
);
INSERT INTO public.greenguard_shard_identity VALUES (true, :'shard_id')
 ON CONFLICT (singleton) DO NOTHING;
SELECT 1 / CASE WHEN shard_id = :'shard_id' THEN 1 ELSE 0 END
 FROM public.greenguard_shard_identity;
REVOKE ALL ON public.greenguard_shard_identity FROM PUBLIC;

-- Local-only authentication config. SQL avoids executable bind-mount behavior
-- in Docker Desktop when entrypoint discovers init shell files.
\getenv pgdata PGDATA
\getenv replication_cidr GG_SHARD_NETWORK_CIDR
SELECT :'pgdata' || '/pg_hba.conf' AS hba_path \gset
COPY (SELECT line FROM (VALUES
 ('local all postgres trust'),
 ('local all all scram-sha-256'),
 ('local replication gg_replicator scram-sha-256'),
 ('host all all all scram-sha-256'),
 (format('host replication gg_replicator %s scram-sha-256', :'replication_cidr'))
) AS rules(line)) TO :'hba_path';
