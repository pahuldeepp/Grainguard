#!/bin/sh
# Live Kafka acceptance probe. Runs inside the cell with the dedicated
# least-privilege "acceptance-probe" SASL principal.
#   1. produce one uniquely keyed record to greenguard.acceptance.probe.v1
#   2. consume that exact key/value back
#   3. prove deny-by-default: a write to a topic without any ACL and a read of
#      a domain topic must both fail with TopicAuthorizationException
# Records cannot be deleted by this principal; the topic's ten-minute
# retention is the cleanup. No credential is printed.
set -eu
umask 077

broker="${KAFKA_BOOTSTRAP:-kafka.greenguard.svc.cluster.local:29092}"
ca="${KAFKA_CA_FILE:-/etc/greenguard/kafka/ca.crt}"
bin="${KAFKA_BIN:-/opt/kafka/bin}"
work="${PROBE_WORK_DIR:-/tmp}"
topic=greenguard.acceptance.probe.v1
denied_write_topic=greenguard.acceptance.denied.v1
denied_read_topic=greenguard.telemetry.recorded.v2
group=greenguard-acceptance-probe
ready_attempts="${PROBE_READY_ATTEMPTS:-36}"

fail() {
  echo "FAIL kafka-produce-consume: $1" >&2
  exit 1
}
# Client logs never contain the JAAS value, but filter defensively.
diagnostics() {
  grep -v -i -e password -e jaas "$1" 2>/dev/null | tail -n 12 >&2 || true
}

: "${KAFKA_SASL_JAAS_CONFIG:?Kafka acceptance JAAS is required}"
case "$KAFKA_SASL_JAAS_CONFIG" in
  *'username="acceptance-probe"'*) ;;
  *) fail 'credential is not the dedicated acceptance-probe principal' ;;
esac
test -s "$ca" || fail 'Kafka CA bundle is missing'

config="$work/kafka-client.properties"
printf 'security.protocol=SASL_SSL\nsasl.mechanism=PLAIN\nsasl.jaas.config=%s\nssl.truststore.type=PEM\nssl.truststore.location=%s\nssl.endpoint.identification.algorithm=https\n' \
  "$KAFKA_SASL_JAAS_CONFIG" "$ca" > "$config"

# Argo sync waves do not prove the broker, ACL and topic Jobs have converged,
# so wait (bounded) until this principal can describe its own topic.
attempt=0
until "$bin/kafka-topics.sh" --bootstrap-server "$broker" --command-config "$config" \
  --describe --topic "$topic" > "$work/describe.out" 2> "$work/describe.err"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$ready_attempts" ]; then
    diagnostics "$work/describe.err"
    fail 'acceptance topic was not describable with SASL_SSL before the deadline'
  fi
  sleep 5
done
grep -q "Topic: $topic" "$work/describe.out" || fail 'acceptance topic description is malformed'

run_id="$(cat /proc/sys/kernel/random/uuid)"
key="gg-acceptance-$run_id"
value="greenguard-kafka-roundtrip-v1:$run_id"

printf '%s\t%s\n' "$key" "$value" | "$bin/kafka-console-producer.sh" \
  --bootstrap-server "$broker" --producer.config "$config" --topic "$topic" --sync \
  --producer-property enable.idempotence=false --producer-property acks=all \
  --property parse.key=true > "$work/produce.out" 2> "$work/produce.err" || {
  diagnostics "$work/produce.err"
  fail 'authenticated produce to the acceptance topic failed'
}
if grep -q -e 'Exception' -e 'ERROR' "$work/produce.out" "$work/produce.err"; then
  diagnostics "$work/produce.err"
  fail 'producer reported an error for the acceptance topic'
fi

: > "$work/consumed.out"
attempt=0
found=false
while [ "$attempt" -lt 4 ]; do
  attempt=$((attempt + 1))
  "$bin/kafka-console-consumer.sh" --bootstrap-server "$broker" --consumer.config "$config" \
    --topic "$topic" --group "$group" --from-beginning --timeout-ms 20000 \
    --property print.key=true >> "$work/consumed.out" 2> "$work/consume.err" || true
  if grep -F -x -q "$(printf '%s\t%s' "$key" "$value")" "$work/consumed.out"; then
    found=true
    break
  fi
done
if [ "$found" != true ]; then
  diagnostics "$work/consume.err"
  fail 'the produced record was not consumed back with its exact key and value'
fi

# Deny-by-default, write side. This topic exists but has no ACL for anyone.
denied_value="greenguard-kafka-denied-v1:$run_id"
if printf '%s\t%s\n' "$key" "$denied_value" | "$bin/kafka-console-producer.sh" \
  --bootstrap-server "$broker" --producer.config "$config" --topic "$denied_write_topic" --sync \
  --producer-property enable.idempotence=false --producer-property acks=all \
  --producer-property max.block.ms=20000 \
  --property parse.key=true > "$work/denied-write.out" 2>&1; then
  fail 'write to a topic without an ACL was accepted'
fi
grep -q 'TopicAuthorizationException' "$work/denied-write.out" \
  && grep -F -q "$denied_write_topic" "$work/denied-write.out" \
  || { diagnostics "$work/denied-write.out"; fail 'write to a topic without an ACL did not fail with TopicAuthorizationException'; }

# Deny-by-default, read side, against a real domain topic. Any payload is
# discarded so tenant data can never reach this Job's log.
"$bin/kafka-console-consumer.sh" --bootstrap-server "$broker" --consumer.config "$config" \
  --topic "$denied_read_topic" --group "$group" --timeout-ms 10000 --max-messages 1 \
  2> "$work/denied-read.err" | wc -l > "$work/denied-read.count" || true
[ "$(tr -d ' \n' < "$work/denied-read.count")" = 0 ] || fail 'a domain topic record was readable by the acceptance principal'
grep -q 'TopicAuthorizationException' "$work/denied-read.err" \
  && grep -F -q "$denied_read_topic" "$work/denied-read.err" \
  || { diagnostics "$work/denied-read.err"; fail 'read of a domain topic did not fail with TopicAuthorizationException'; }

echo 'PASS kafka-produce-consume: SASL_SSL produce/consume round trip and ACL denial verified'
