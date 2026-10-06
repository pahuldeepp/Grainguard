#!/usr/bin/env bash
set -euo pipefail

container="${GG_POSTGRES_CONTAINER:-greenguard-dev-postgres-1}"
database="${GG_TELEMETRY_DATABASE:-greenguard_telemetry}"
result="$(docker exec "$container" psql -U postgres -d "$database" -Atqc "SELECT bool_and(NOT has_table_privilege('telemetry_app', format('public.%I', table_name), 'DELETE')) FROM unnest(ARRAY['readings','ingest_receipts','outbox_events','audit_events']) AS table_name;")"
if [[ "$result" != "t" ]]; then
  echo "write-side retention guard failed: telemetry_app has DELETE on a canonical table or grants could not be checked" >&2
  exit 1
fi
echo "PASS: telemetry_app has no DELETE privilege on readings, ingest_receipts, outbox_events, or audit_events."
echo "Write-side retention stays disabled until a separately reviewed archive, replay, idempotency, and audit policy is implemented."
