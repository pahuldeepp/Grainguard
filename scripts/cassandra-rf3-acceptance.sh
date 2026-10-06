#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose=(docker compose -f "$root/infra/cassandra/compose.multinode.yaml" -p greenguard-cassandra-rf3)
cleanup() {
  # Keep this lab's data volume, but release its RAM/CPU after the proof.
  "${compose[@]}" stop -t 30 >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "Starting isolated Cassandra RF3 acceptance ring (ports 59043-59045)."
"${compose[@]}" up -d --wait --wait-timeout 600

nodetool_status() {
  "${compose[@]}" exec -T cassandra-1 nodetool status
}

status="$(nodetool_status)"
up_count="$(printf '%s\n' "$status" | awk '$1 == "UN" { count++ } END { print count+0 }')"
if [[ "$up_count" != 3 ]]; then
  printf '%s\n' "$status" >&2
  echo "Expected three UN Cassandra nodes, found $up_count." >&2
  exit 1
fi

cql() { "${compose[@]}" exec -T cassandra-1 cqlsh -e "$1"; }
cql "CREATE KEYSPACE IF NOT EXISTS gg_rf3_acceptance WITH replication = {'class':'NetworkTopologyStrategy','datacenter1':3} AND durable_writes = true;"
cql "CREATE TABLE IF NOT EXISTS gg_rf3_acceptance.probe (id text PRIMARY KEY, value text);"
replicas="$("${compose[@]}" exec -T cassandra-1 nodetool getendpoints gg_rf3_acceptance probe before-outage)"
replica_count="$(printf '%s\n' "$replicas" | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { seen[$0]=1 } END { for (ip in seen) count++; print count+0 }')"
if [[ "$replica_count" != 3 ]]; then
  printf '%s\n' "$replicas" >&2
  echo "Expected the RF3 probe row on three distinct nodes, found $replica_count replicas." >&2
  exit 1
fi
cql "CONSISTENCY LOCAL_QUORUM; INSERT INTO gg_rf3_acceptance.probe (id, value) VALUES ('before-outage', 'durable'); SELECT value FROM gg_rf3_acceptance.probe WHERE id='before-outage';" | grep -q durable

echo "Stopping one replica and proving LOCAL_QUORUM reads and writes continue."
"${compose[@]}" stop -t 30 cassandra-3
status="$(nodetool_status)"
up_count="$(printf '%s\n' "$status" | awk '$1 == "UN" { count++ } END { print count+0 }')"
if [[ "$up_count" != 2 ]]; then
  printf '%s\n' "$status" >&2
  echo "Expected two UN nodes during the single-node outage, found $up_count." >&2
  exit 1
fi
cql "CONSISTENCY LOCAL_QUORUM; SELECT value FROM gg_rf3_acceptance.probe WHERE id='before-outage'; INSERT INTO gg_rf3_acceptance.probe (id, value) VALUES ('during-outage', 'quorum-write'); SELECT value FROM gg_rf3_acceptance.probe WHERE id='during-outage';" | grep -q quorum-write

echo "Restarting the replica and verifying it rejoins the RF3 ring."
"${compose[@]}" up -d --wait --wait-timeout 360 cassandra-3
status="$(nodetool_status)"
up_count="$(printf '%s\n' "$status" | awk '$1 == "UN" { count++ } END { print count+0 }')"
if [[ "$up_count" != 3 ]]; then
  printf '%s\n' "$status" >&2
  echo "Expected three UN nodes after recovery, found $up_count." >&2
  exit 1
fi
cql "CONSISTENCY LOCAL_QUORUM; SELECT value FROM gg_rf3_acceptance.probe WHERE id='before-outage'; SELECT value FROM gg_rf3_acceptance.probe WHERE id='during-outage';" | grep -q quorum-write

echo "PASS: RF3 LOCAL_QUORUM read/write survived one node outage; node rejoined and retained both rows."
echo "Ring status:"
printf '%s\n' "$status"
