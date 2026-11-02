#!/bin/sh
# Creates the derived topics (idempotent). Usage: infra/flink/topics.sh "<docker compose command prefix>" [partitions]
# Derived topics are optional and never provisioned by scripts/kafka-topics.mjs.
set -eu
COMPOSE=${1:?compose command prefix required}
PARTITIONS=${2:-6}
create() { # name partitions extra-config...
  name=$1; parts=$2; shift 2
  $COMPOSE exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:29092 --create --if-not-exists \
    --topic "$name" --partitions "$parts" --replication-factor 1 "$@" >/dev/null
  echo "$name: $parts partitions"
}
# Standalone test brokers have no CDC transformer: CREATE_INPUT=1 also creates the canonical input topic.
[ "${CREATE_INPUT:-0}" = "1" ] && create greenguard.telemetry.recorded.v1 "${INPUT_PARTITIONS:-6}"
create greenguard.telemetry.aggregate.v1 "$PARTITIONS"
create greenguard.telemetry.anomaly.v1 "$PARTITIONS"
# Raw bytes of rejected input may contain tenant data: short retention, ACL-restricted in production.
create greenguard.stream.dlq.v1 3 --config retention.ms=604800000
