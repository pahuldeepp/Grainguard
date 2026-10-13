#!/usr/bin/env bash
set -euo pipefail

# Offline disposable PostgreSQL acceptance for the optional AI owner databases.
# Uses only a uniquely named, portless, memory-limited local container and fixed
# synthetic credentials. It does not contact AWS or a configured project DB.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
sql="$root/infra/gitops/disposable/ai-database-bootstrap-chart/files/ai-databases.sql"
container="gg-ai-migration-check-$$-$RANDOM"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker run -d --name "$container" --memory=512m --cpus=1 -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=fixture-admin-only postgres:16-alpine >/dev/null
ready=false
for _ in $(seq 1 45); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { echo "fixture PostgreSQL did not become ready" >&2; exit 1; }

docker exec "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE greenguard_admin LOGIN CREATEROLE CREATEDB PASSWORD 'fixture-admin-only'" >/dev/null
docker cp "$sql" "$container:/tmp/ai-databases.sql"

role_env=()
for key in KNOWLEDGE_APP KNOWLEDGE_WORKER KNOWLEDGE_MIGRATOR KNOWLEDGE_PROVISIONER KNOWLEDGE_REVIEWER \
  ADVISOR_APP ADVISOR_MIGRATOR ADVISOR_CHECKPOINT_APP ADVISOR_CHECKPOINT_MIGRATOR \
  MODEL_GATEWAY_APP MODEL_GATEWAY_USAGE MODEL_GATEWAY_MIGRATOR; do
  lower="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"
  role_env+=( -e "${key}_PASSWORD=fixture-${lower}-password-with-minimum-length-123" )
done
docker exec "${role_env[@]}" "$container" psql -U greenguard_admin -d postgres \
  -v ON_ERROR_STOP=1 -f /tmp/ai-databases.sql >/dev/null
docker exec "${role_env[@]}" "$container" psql -U greenguard_admin -d postgres \
  -v ON_ERROR_STOP=1 -f /tmp/ai-databases.sql >/dev/null

apply_migrations() {
  local role="$1" database="$2" ledger="$3" lock="$4" file version found
  shift 4
  docker exec "$container" psql -U "$role" -d "$database" -v ON_ERROR_STOP=1 \
    -c "CREATE TABLE IF NOT EXISTS ${ledger}(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())" >/dev/null
  for file in "$@"; do
    version="$(basename "$file")"
    version="${version%.up.sql}"
    version="${version%.sql}"
    found="$(docker exec "$container" psql -U "$role" -d "$database" -Atc \
      "SELECT 1 FROM ${ledger} WHERE version='${version}'" 2>/dev/null || true)"
    if [[ -z "$found" ]]; then
      {
        printf 'BEGIN; SELECT pg_advisory_xact_lock(hashtext(%s));\n' "'${lock}'"
        cat "$file"
        printf "\nINSERT INTO %s(version) VALUES ('%s'); COMMIT;\n" "$ledger" "$version"
      } | docker exec -i "$container" psql -U "$role" -d "$database" -v ON_ERROR_STOP=1 -f - >/dev/null
    fi
  done
}

knowledge=("$root"/services/knowledge-service/migrations/*.up.sql)
advisor=("$root"/services/grain-advisor/migrations/*.up.sql)
gateway=("$root"/services/model-gateway/migrations/*.sql)
apply_migrations knowledge_migrator greenguard_knowledge knowledge_schema_migrations greenguard.knowledge.migrations "${knowledge[@]}"
apply_migrations advisor_migrator greenguard_advisor advisor_schema_migrations greenguard.advisor.migrations "${advisor[@]}"
apply_migrations model_gateway_migrator greenguard_ai_usage model_gateway_schema_migrations greenguard.model-gateway.migrations "${gateway[@]}"
# A second pass must skip every migration recorded by its owner.
apply_migrations knowledge_migrator greenguard_knowledge knowledge_schema_migrations greenguard.knowledge.migrations "${knowledge[@]}"
apply_migrations advisor_migrator greenguard_advisor advisor_schema_migrations greenguard.advisor.migrations "${advisor[@]}"
apply_migrations model_gateway_migrator greenguard_ai_usage model_gateway_schema_migrations greenguard.model-gateway.migrations "${gateway[@]}"

for spec in \
  'knowledge_migrator greenguard_knowledge knowledge_schema_migrations' \
  'advisor_migrator greenguard_advisor advisor_schema_migrations' \
  'model_gateway_migrator greenguard_ai_usage model_gateway_schema_migrations'; do
  read -r role database ledger <<<"$spec"
  count="$(docker exec "$container" psql -U "$role" -d "$database" -Atc "SELECT count(*) FROM $ledger")"
  echo "migrations:$database=$count"
  unprotected="$(docker exec "$container" psql -U "$role" -d "$database" -Atc "SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND EXISTS (SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema='public' AND col.table_name=c.relname AND col.column_name='tenant_id')
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")"
  [[ -z "$unprotected" ]] || { echo "unprotected tenant tables in $database: $unprotected" >&2; exit 1; }
done
unsafe="$(docker exec "$container" psql -U postgres -d postgres -Atc "SELECT rolname
  FROM pg_roles WHERE rolname IN ('knowledge_app','knowledge_worker','knowledge_migrator','advisor_app',
    'advisor_migrator','model_gateway_app','model_gateway_migrator') AND (rolsuper OR rolbypassrls)")"
[[ -z "$unsafe" ]] || { echo "unsafe AI roles: $unsafe" >&2; exit 1; }
# Runtime application roles cannot create arbitrary objects in public schema.
for spec in \
  'knowledge_app greenguard_knowledge' \
  'knowledge_worker greenguard_knowledge' \
  'advisor_app greenguard_advisor' \
  'model_gateway_app greenguard_ai_usage'; do
  read -r role database <<<"$spec"
  identity="$(docker exec "$container" psql -U "$role" -d "$database" -Atc \
    "SELECT current_user||':'||current_database()||':'||has_schema_privilege(current_user,'public','CREATE')")"
  can_create="${identity##*:}"
  [[ "$can_create" == false ]] || {
    acl="$(docker exec "$container" psql -U postgres -d "$database" -Atc \
      "SELECT coalesce(nspacl::text,'NULL') FROM pg_namespace WHERE nspname='public'")"
    members="$(docker exec "$container" psql -U postgres -d "$database" -Atc \
      "SELECT target.rolname||'<'||member.rolname FROM pg_auth_members m JOIN pg_roles target ON target.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE target.rolname='${role}' OR member.rolname='${role}'")"
    echo "$role can create in $database public schema (check=$identity; acl=$acl; memberships=$members)" >&2; exit 1;
  }
done
worker_contract="$(docker exec "$container" psql -U knowledge_worker -d greenguard_knowledge -Atc \
  "SELECT has_table_privilege(current_user,'knowledge_documents','SELECT,INSERT,UPDATE,DELETE')||':'||has_table_privilege(current_user,'assistant_summary_jobs','SELECT,INSERT,UPDATE,DELETE')||':'||has_table_privilege(current_user,'knowledge_auth_memberships','SELECT')")"
[[ "$worker_contract" == "true:true:false" ]] || { echo "Knowledge worker grants are not scoped as expected: $worker_contract" >&2; exit 1; }
# Exercise dependency retry state as the production non-owner worker role. A
# document already parsed by the durable source path must survive more than
# five transient vector/provider failures: retry is scheduled, not quarantined,
# the source remains unprocessed, and the real relay claim predicate can select
# it again once its bounded backoff has elapsed.
docker exec -i "$container" psql -U knowledge_worker -d greenguard_knowledge -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $retry$
DECLARE
  tenant uuid := '11111111-1111-4111-8111-111111111111';
  document uuid := '22222222-2222-4222-8222-222222222222';
  event uuid := '33333333-3333-4333-8333-333333333333';
  attempt_no integer;
  state record;
  claimed uuid;
BEGIN
  PERFORM set_config('app.tenant_id', tenant::text, true);
  INSERT INTO knowledge_documents(tenant_id,document_id,current_version,latest_version)
    VALUES (tenant,document,1,1);
  INSERT INTO knowledge_document_versions(tenant_id,document_id,document_version,source_sha256,media_type,processing_status)
    VALUES (tenant,document,1,repeat('a',64),'application/pdf','parsed');
  INSERT INTO knowledge_index_outbox(event_id,tenant_id,document_id,document_version,chunk_ids,published_at)
    VALUES (event,tenant,document,1,'{}',clock_timestamp());
  FOR attempt_no IN 1..7 LOOP
    WITH failure AS (
      INSERT INTO knowledge_index_failures(tenant_id,event_id,reason)
      VALUES (tenant,event,'index_unavailable')
      ON CONFLICT (tenant_id,event_id) DO UPDATE
        SET attempts=knowledge_index_failures.attempts+1,
            reason=EXCLUDED.reason, updated_at=clock_timestamp()
      RETURNING attempts
    )
    UPDATE knowledge_index_outbox o
       SET available_at=clock_timestamp()+
             (LEAST(15 * power(2,LEAST(failure.attempts-1,5)),300) * interval '1 second'),
           published_at=NULL,claim_token=NULL,claimed_until=NULL
      FROM failure
     WHERE o.tenant_id=tenant AND o.event_id=event AND o.processed_at IS NULL;
  END LOOP;
  SELECT f.attempts,f.quarantined_at,o.available_at,o.published_at,o.processed_at,v.processing_status
    INTO state
    FROM knowledge_index_failures f
    JOIN knowledge_index_outbox o USING (tenant_id,event_id)
    JOIN knowledge_document_versions v USING (tenant_id,document_id,document_version)
   WHERE f.tenant_id=tenant AND f.event_id=event;
  IF state.attempts <> 7 OR state.quarantined_at IS NOT NULL
     OR state.available_at <= clock_timestamp() OR state.published_at IS NOT NULL
     OR state.processed_at IS NOT NULL OR state.processing_status <> 'parsed' THEN
    RAISE EXCEPTION 'transient retry state not preserved after seven failures';
  END IF;
  UPDATE knowledge_index_outbox SET available_at=clock_timestamp()-interval '1 second'
   WHERE tenant_id=tenant AND event_id=event;
  WITH candidates AS (
    SELECT o.event_id FROM knowledge_index_outbox o
    JOIN knowledge_document_versions v USING (tenant_id,document_id,document_version)
    WHERE o.tenant_id=tenant AND o.processed_at IS NULL AND o.published_at IS NULL
      AND o.available_at<=clock_timestamp() AND v.processing_status='parsed'
      AND (o.claimed_until IS NULL OR o.claimed_until<=clock_timestamp())
    ORDER BY o.created_at,o.event_id FOR UPDATE OF o SKIP LOCKED LIMIT 1
  )
  UPDATE knowledge_index_outbox o
     SET claim_token=gen_random_uuid(),claimed_until=clock_timestamp()+interval '15 minutes'
    FROM candidates c WHERE o.tenant_id=tenant AND o.event_id=c.event_id
    RETURNING o.event_id INTO claimed;
  IF claimed IS DISTINCT FROM event THEN
    RAISE EXCEPTION 'due parsed retry was not selectable by the index relay';
  END IF;
END
$retry$;
SQL
# Prove the Advisor runtime policy isolates rows for both tenant and user.
tenant_a=11111111-1111-4111-8111-111111111111
tenant_b=22222222-2222-4222-8222-222222222222
user_a=33333333-3333-4333-8333-333333333333
proposal=44444444-4444-4444-8444-444444444444
docker exec "$container" psql -U advisor_app -d greenguard_advisor -v ON_ERROR_STOP=1 -c \
  "BEGIN; SELECT set_config('app.tenant_id','$tenant_a',true); SELECT set_config('app.user_id','$user_a',true); SELECT set_config('app.role','viewer',true); INSERT INTO action_proposals(tenant_id,proposal_id,run_id,user_id,action_hash,action,status,expires_at) VALUES ('$tenant_a','$proposal','$proposal','$user_a',repeat('a',64),'{}','pending',clock_timestamp()+interval '1 day'); COMMIT" >/dev/null
unscoped_count="$(docker exec "$container" psql -U advisor_app -d greenguard_advisor -Atc \
  "SELECT count(*) FROM action_proposals WHERE proposal_id='$proposal'")"
foreign_count="$(docker exec "$container" psql -U advisor_app -d greenguard_advisor -Atc \
  "BEGIN; SELECT set_config('app.tenant_id','$tenant_b',true); SELECT set_config('app.user_id','$user_a',true); SELECT count(*) FROM action_proposals WHERE proposal_id='$proposal'; COMMIT" | grep -E '^[0-9]+$' | tail -1)"
owner_count="$(docker exec "$container" psql -U advisor_app -d greenguard_advisor -Atc \
  "BEGIN; SELECT set_config('app.tenant_id','$tenant_a',true); SELECT set_config('app.user_id','$user_a',true); SELECT count(*) FROM action_proposals WHERE proposal_id='$proposal'; COMMIT" | grep -E '^[0-9]+$' | tail -1)"
[[ "$unscoped_count" == 0 && "$foreign_count" == 0 && "$owner_count" == 1 ]] || {
  echo "Advisor tenant/user RLS isolation failed (unscoped=$unscoped_count foreign=$foreign_count owner=$owner_count)" >&2; exit 1;
}
# Exercise the production Go cap writer against this isolated database. The
# fixture bypasses only the public-RDS hostname guard; role/RLS/ownership checks,
# transaction logic, and cap-decrease protections are identical.
published_port="$(docker port "$container" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
(cd "$root/services/model-gateway" && \
  MODEL_GATEWAY_BUDGET_FIXTURE_DSN="postgresql://model_gateway_migrator:fixture-model_gateway_migrator-password-with-minimum-length-123@127.0.0.1:${published_port}/greenguard_ai_usage?sslmode=disable" \
  go test -run '^TestApplyBudgetCapsFixturePreservesUsageAndRejectsUnsafeDecrease$' .)
echo "AI bootstrap + owner migrations + RLS checks passed (local fixture only)"
