#!/usr/bin/env bash
# Stage 09f local runtime. Requires .env, migrated control/notification DBs,
# Kafka topic greenguard.platform.config.v1, and RabbitMQ from the dev stack.
set -euo pipefail
cd "$(dirname "$0")/.."

export PORT=18098
export CONTROL_PLANE_URL=http://127.0.0.1:18098
export KAFKA_BROKERS="${KAFKA_BROKERS:-127.0.0.1:59092}"
export NOTIFICATIONS_HTTP_PORT=18096

node --env-file=.env services/tenant-control-plane/dist/main.js &
control_pid=$!
cleanup() {
  kill "$control_pid" 2>/dev/null || true
  wait "$control_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for ((i=0; i<60; i++)); do
  if curl --silent --fail http://127.0.0.1:18098/readyz >/dev/null; then break; fi
  if ! kill -0 "$control_pid" 2>/dev/null; then echo "control plane exited" >&2; exit 1; fi
  sleep 0.5
done
curl --silent --fail http://127.0.0.1:18098/readyz >/dev/null || { echo "control plane not ready" >&2; exit 1; }

echo "Stage 09f control plane ready on :18098; notification worker on :18096"
echo "Flag feed: $KAFKA_BROKERS; snapshot refresh: $CONTROL_PLANE_URL"
node --env-file=.env services/notification-service/dist/main.js
