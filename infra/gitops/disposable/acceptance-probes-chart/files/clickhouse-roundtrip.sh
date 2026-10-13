#!/bin/bash
# The owned 25.3.6.56-alpine image supplies bash and the native client.
# Private native TCP is protected by STRICT mesh mTLS; no domain table touched.
set -euo pipefail
umask 077
: "${CLICKHOUSE_USER:?owned ClickHouse user required}"
: "${CLICKHOUSE_PASSWORD:?owned ClickHouse password required}"
work=${PROBE_WORK_DIR:-/tmp}
config="$work/clickhouse-client.xml"
queries="$work/clickhouse-roundtrip.sql"
xml_escape() {
  local value="$1"
  value="${value//&/\&amp;}"
  value="${value//</\&lt;}"
  value="${value//>/\&gt;}"
  value="${value//\"/\&quot;}"
  value="${value//\'/\&apos;}"
  printf '%s' "$value"
}
# Password is read from a private config, never passed as an argument.
printf '<config><host>greenguard-clickhouse.greenguard.svc.cluster.local</host><port>9000</port><user>%s</user><password>%s</password><connect_timeout>5</connect_timeout><send_timeout>20</send_timeout><receive_timeout>20</receive_timeout><history_file>/dev/null</history_file></config>\n' \
  "$(xml_escape "$CLICKHOUSE_USER")" "$(xml_escape "$CLICKHOUSE_PASSWORD")" > "$config"
cleanup() { rm -f "$config" "$queries"; }
trap cleanup EXIT
ready=false
for attempt in $(seq 1 "${PROBE_READY_ATTEMPTS:-36}"); do
  if [ "$(clickhouse-client --config-file "$config" --query 'SELECT 1' 2>/dev/null)" = 1 ]; then ready=true; break; fi
  sleep 5
done
[ "$ready" = true ] || { echo 'FAIL clickhouse-roundtrip: authenticated native query unavailable' >&2; exit 1; }
run_id=$(cat /proc/sys/kernel/random/uuid)
tenant_a=$(cat /proc/sys/kernel/random/uuid)
tenant_b=$(cat /proc/sys/kernel/random/uuid)
cat > "$queries" <<SQL
CREATE TEMPORARY TABLE greenguard_acceptance_probe (tenant_id UUID, marker String) ENGINE = Memory;
INSERT INTO greenguard_acceptance_probe VALUES ('$tenant_a', 'marker-$run_id'), ('$tenant_b', 'other-$run_id');
SELECT throwIf(count() != 1 OR any(marker) != 'marker-$run_id', 'acceptance tenant A insert/select failed') FROM greenguard_acceptance_probe WHERE tenant_id = '$tenant_a';
SELECT throwIf(count() != 1 OR any(marker) != 'other-$run_id', 'acceptance tenant B insert/select failed') FROM greenguard_acceptance_probe WHERE tenant_id = '$tenant_b';
SELECT throwIf(count() != 0, 'acceptance cross-tenant filter failed') FROM greenguard_acceptance_probe WHERE tenant_id = '$tenant_b' AND marker = 'marker-$run_id';
DROP TEMPORARY TABLE greenguard_acceptance_probe;
SQL
# All statements run on one native session; disconnect also removes temporary
# data if an assertion or DROP fails. Actual client errors fail this Job.
clickhouse-client --config-file "$config" --queries-file "$queries" --format=Null
cleanup
trap - EXIT
echo 'PASS clickhouse-roundtrip: authenticated native fixture insert/select, tenant filter and cleanup verified'
