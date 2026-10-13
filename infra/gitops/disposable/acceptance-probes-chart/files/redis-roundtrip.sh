#!/bin/sh
# Redis AUTH over STRICT Istio mTLS. Disposable tenant-prefixed keys only;
# application-level filtering is demonstrated, not server-side tenant ACLs.
set -eu
: "${REDISCLI_AUTH:?owned Redis password required}"
host=redis-cluster-0.redis-headless.greenguard.svc.cluster.local
client() { redis-cli -c -h "$host" --raw "$@"; }
ready=false
for attempt in $(seq 1 "${PROBE_READY_ATTEMPTS:-36}"); do
  if client cluster info | tr -d '\r' | grep -qx 'cluster_state:ok'; then ready=true; break; fi
  sleep 5
done
[ "$ready" = true ] || { echo 'FAIL redis-tenant-cache-roundtrip: cluster unavailable' >&2; exit 1; }
# Prove the endpoint requires AUTH without printing any credential.
unauthed=$(env -u REDISCLI_AUTH redis-cli -h "$host" --raw ping 2>&1 || true)
case "$unauthed" in *NOAUTH*) ;; *) echo 'FAIL redis-tenant-cache-roundtrip: unauthenticated PING not denied' >&2; exit 1;; esac
run_id=$(cat /proc/sys/kernel/random/uuid)
tenant_a=$(cat /proc/sys/kernel/random/uuid)
tenant_b=$(cat /proc/sys/kernel/random/uuid)
key_a="gg:acceptance:{$tenant_a}:$run_id"
key_b="gg:acceptance:{$tenant_b}:$run_id"
cleanup() { client DEL "$key_a" >/dev/null 2>&1 || true; client DEL "$key_b" >/dev/null 2>&1 || true; }
trap cleanup EXIT
[ "$(client SET "$key_a" "marker-$run_id" EX 120 NX)" = OK ]
[ "$(client SET "$key_b" "other-$run_id" EX 120 NX)" = OK ]
[ "$(client GET "$key_a")" = "marker-$run_id" ]
[ "$(client GET "$key_b")" = "other-$run_id" ]
ttl=$(client TTL "$key_a")
{ [ "$ttl" -gt 0 ] && [ "$ttl" -le 120 ]; } || { echo 'FAIL redis-tenant-cache-roundtrip: fixture TTL missing or invalid' >&2; exit 1; }
[ "$(client DEL "$key_a")" = 1 ]
[ "$(client DEL "$key_b")" = 1 ]
[ "$(client EXISTS "$key_a")" = 0 ]
[ "$(client EXISTS "$key_b")" = 0 ]
trap - EXIT
echo 'PASS redis-tenant-cache-roundtrip: AUTH, tenant key separation, TTL and cleanup verified'
