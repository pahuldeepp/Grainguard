#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$ROOT/services/tenant-control-plane/prisma/migrations/20260929200000_durable_tenant_bootstrap/migration.sql"
NAME="gg-bootstrap-sql-test-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm -d --name "$NAME" -e POSTGRES_PASSWORD=test \
  postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres >/dev/null

psql_test() {
  docker exec -i "$NAME" psql -U postgres -d greenguard_control -v ON_ERROR_STOP=1 "$@"
}
psql_admin() {
  docker exec -i "$NAME" psql -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"
}
psql_worker_test() {
  docker exec -i -e PGPASSWORD=worker-test -e PGOPTIONS='-c role=control_bootstrap_worker_role' \
    "$NAME" psql -h 127.0.0.1 -U tenant_bootstrap_worker -d greenguard_control -v ON_ERROR_STOP=1 "$@"
}

psql_admin <<'SQL'
CREATE DATABASE greenguard_control;
CREATE ROLE control_app NOLOGIN;
CREATE ROLE control_migrator NOLOGIN;
CREATE ROLE control_bootstrap_worker_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE tenant_bootstrap_worker LOGIN PASSWORD 'worker-test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT control_bootstrap_worker_role TO tenant_bootstrap_worker WITH INHERIT FALSE, SET TRUE;
SQL

psql_test <<'SQL'
CREATE TABLE identities (identity_id uuid PRIMARY KEY);
CREATE TABLE shard_registry (
  shard_id text PRIMARY KEY, shard_incarnation uuid NOT NULL,
  state text NOT NULL
);
CREATE TABLE organizations (
  tenant_id uuid PRIMARY KEY, created_by uuid REFERENCES identities,
  shard_id text REFERENCES shard_registry, shard_incarnation uuid,
  routing_epoch bigint NOT NULL, state text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE memberships (tenant_id uuid, identity_id uuid, role text, state text, version bigint);
CREATE TABLE membership_events (tenant_id uuid, audit_id uuid);
CREATE TABLE outbox_events (tenant_id uuid, event_id uuid);
INSERT INTO identities VALUES ('a2123456-0000-4000-8000-000000000001');
INSERT INTO shard_registry VALUES
  ('s2','f1123456-0000-4000-8000-000000000002','active');
INSERT INTO organizations VALUES
  ('f0123456-0000-4000-8000-000000000001',
   'a2123456-0000-4000-8000-000000000001','s2',
   'f1123456-0000-4000-8000-000000000002',1,'provisioning');
SQL
psql_test < "$MIGRATION" >/dev/null
psql_test < "$ROOT/services/tenant-control-plane/prisma/migrations/20260930200000_isolate_tenant_bootstrap_worker/migration.sql" >/dev/null

# Confirm legacy provisioning rows are queued with correlation and trace context.
psql_test -Atc "SELECT count(*)=1 AND bool_and(correlation_id=operation_id) AND bool_and(traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-01$') FROM tenant_bootstrap_jobs" | grep -qx t
psql_worker_test -Atc "SELECT session_user='tenant_bootstrap_worker' AND current_user='control_bootstrap_worker_role'" | grep -qx t

# Worker claim exposes trace context; expiry gives a new fencing token, stale
# claims cannot retry, and the bounded backoff/retry cap transitions to blocked.
psql_worker_test <<'SQL'
DO $$
DECLARE first_claim record; second_claim record; third_claim record;
        stale_rejected boolean := false; retry_state text;
BEGIN
  PERFORM set_config('app.tenant_id','f0123456-0000-4000-8000-000000000001',true);
  SELECT * INTO first_claim FROM claim_tenant_bootstrap_job();
  IF first_claim.tenant_id IS NULL OR first_claim.correlation_id IS NULL OR
     first_claim.traceparent IS NULL THEN
    RAISE EXCEPTION 'claim omitted durable trace/correlation context';
  END IF;
  IF EXISTS (SELECT 1 FROM claim_tenant_bootstrap_job()) THEN
    RAISE EXCEPTION 'live job was claimed twice';
  END IF;
  UPDATE tenant_bootstrap_jobs SET lease_until=clock_timestamp()-interval '1 second'
   WHERE tenant_id=first_claim.tenant_id;
  SELECT * INTO second_claim FROM claim_tenant_bootstrap_job();
  IF second_claim.claim_token=first_claim.claim_token THEN
    RAISE EXCEPTION 'expired claim token was reused';
  END IF;
  BEGIN
    PERFORM retry_tenant_bootstrap_job(first_claim.tenant_id,first_claim.job_id,
      first_claim.claim_token,'retryable_failure');
  EXCEPTION WHEN OTHERS THEN stale_rejected := true;
  END;
  IF NOT stale_rejected THEN RAISE EXCEPTION 'stale claim was accepted'; END IF;

  retry_state := retry_tenant_bootstrap_job(second_claim.tenant_id,second_claim.job_id,
    second_claim.claim_token,'owner_unavailable');
  IF retry_state <> 'retry_wait' OR NOT EXISTS (
    SELECT 1 FROM tenant_bootstrap_jobs WHERE tenant_id=second_claim.tenant_id
      AND next_attempt_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'retry backoff was not scheduled';
  END IF;
  UPDATE tenant_bootstrap_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'
   WHERE tenant_id=second_claim.tenant_id;
  SELECT * INTO third_claim FROM claim_tenant_bootstrap_job();
  IF third_claim.tenant_id IS NULL THEN RAISE EXCEPTION 'due retry was not claimed'; END IF;
  UPDATE tenant_bootstrap_jobs SET attempts=8 WHERE tenant_id=third_claim.tenant_id;
  retry_state := retry_tenant_bootstrap_job(third_claim.tenant_id,third_claim.job_id,
    third_claim.claim_token,'owner_contract_unavailable');
  IF retry_state <> 'blocked' THEN RAISE EXCEPTION 'attempt cap did not block job'; END IF;
END $$;
SQL

# The normal application can only see its tenant under RLS and cannot alter
# bootstrap ownership/admin intent or call the restricted worker role directly.
psql_test <<'SQL'
SET ROLE control_app;
SELECT set_config('app.tenant_id','f0123456-0000-4000-8000-000000000001',false);
DO $$ BEGIN
  IF (SELECT count(*) FROM tenant_bootstrap_jobs) <> 1 THEN
    RAISE EXCEPTION 'tenant RLS failed';
  END IF;
  IF has_table_privilege(current_user,'tenant_bootstrap_jobs','UPDATE') THEN
    RAISE EXCEPTION 'unexpected table-wide update privilege';
  END IF;
  IF has_table_privilege(current_user,'tenant_bootstrap_jobs','DELETE') THEN
    RAISE EXCEPTION 'unexpected delete privilege';
  END IF;
  IF has_column_privilege(current_user,'tenant_bootstrap_jobs','prepared_receipts','UPDATE') THEN
    RAISE EXCEPTION 'API role can forge owner receipts';
  END IF;
  IF has_function_privilege(current_user,'claim_tenant_bootstrap_job()','EXECUTE') THEN
    RAISE EXCEPTION 'API role can claim global bootstrap jobs';
  END IF;
  IF has_function_privilege(current_user,'renew_tenant_bootstrap_job(uuid,uuid,uuid)','EXECUTE') OR
     has_function_privilege(current_user,'retry_tenant_bootstrap_job(uuid,uuid,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'API role can invoke worker claim lifecycle functions';
  END IF;
END $$;
RESET ROLE;
SQL

echo "durable tenant-bootstrap PostgreSQL migration checks passed"
