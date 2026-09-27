#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${STAGE12_POSTGRES_IMAGE:-postgres:16-alpine}"
source="greenguard-stage12-backup-source-$$"
target="greenguard-stage12-backup-target-$$"
source_id=""
target_id=""
mkdir -p "$root/work"
work="$(mktemp -d "$root/work/stage12-restore.XXXXXX")"
dump="$work/greenguard.dump"
started="$(date +%s)"

cleanup() {
  # Remove only IDs returned by successful creates, never an unowned name.
  local ids=()
  if [[ -n "$source_id" ]]; then ids+=("$source_id"); fi
  if [[ -n "$target_id" ]]; then ids+=("$target_id"); fi
  if [[ ${#ids[@]} -gt 0 ]]; then
    docker rm -fv "${ids[@]}" >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "Required local image is missing: $image (the rehearsal will not pull images)." >&2
  exit 2
fi

start_postgres() {
  local name="$1" database="$2" id_variable="$3" id
  if ! id="$(docker run --detach --name "$name" \
    --env POSTGRES_DB="$database" \
    --env POSTGRES_HOST_AUTH_METHOD=trust \
    "$image")"; then
    return 1
  fi
  printf -v "$id_variable" '%s' "$id"
  for _ in $(seq 1 60); do
    if docker exec "$id" pg_isready -U postgres -d "$database" >/dev/null 2>&1 &&
      docker exec "$id" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" \
        -Atqc 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Postgres did not become ready: $name" >&2
  return 1
}

start_postgres "$source" greenguard source_id
docker exec -i "$source_id" psql -v ON_ERROR_STOP=1 -U postgres -d greenguard <<'SQL'
CREATE ROLE tenant_runtime NOLOGIN;
CREATE TABLE public.tenant_backup_fixture (
  tenant_id text NOT NULL,
  record_id text NOT NULL,
  PRIMARY KEY (tenant_id, record_id)
);
ALTER TABLE public.tenant_backup_fixture ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_backup_fixture FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.tenant_backup_fixture
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT ON public.tenant_backup_fixture TO tenant_runtime;
INSERT INTO public.tenant_backup_fixture (tenant_id, record_id) VALUES
  ('tenant-a', 'a-001'), ('tenant-a', 'a-002'),
  ('tenant-b', 'b-001');
SQL

docker exec "$source_id" pg_dump -U postgres -d greenguard \
  --format=custom --no-owner --file=/tmp/greenguard.dump
docker cp "$source_id:/tmp/greenguard.dump" "$dump" >/dev/null

start_postgres "$target" greenguard_restore target_id
docker exec "$target_id" psql -v ON_ERROR_STOP=1 -U postgres -d greenguard_restore \
  -c 'CREATE ROLE tenant_runtime NOLOGIN' >/dev/null
docker exec -i "$target_id" pg_restore --exit-on-error --no-owner \
  -U postgres -d greenguard_restore < "$dump"

result="$(docker exec -i "$target_id" psql -qAt -v ON_ERROR_STOP=1 \
  -U postgres -d greenguard_restore <<'SQL'
BEGIN;
SET LOCAL ROLE tenant_runtime;
SET LOCAL app.tenant_id = 'tenant-a';
SELECT 'tenant-a:' || count(*) FROM public.tenant_backup_fixture;
SET LOCAL app.tenant_id = 'tenant-b';
SELECT 'tenant-b:' || count(*) FROM public.tenant_backup_fixture;
SET LOCAL app.tenant_id = 'tenant-missing';
SELECT 'cross-tenant:' || count(*) FROM public.tenant_backup_fixture;
ROLLBACK;
SQL
)"
expected=$'tenant-a:2\ntenant-b:1\ncross-tenant:0'
if [[ "$result" != "$expected" ]]; then
  printf 'Restored data/RLS mismatch. Expected:\n%s\nActual:\n%s\n' "$expected" "$result" >&2
  exit 1
fi

finished="$(date +%s)"
printf 'Restore rehearsal passed: tenant counts and RLS isolation match; restore elapsed %s seconds.\n' "$((finished - started))"
