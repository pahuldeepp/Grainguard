"""Publish one canonical deterministic telemetry fixture over SASL_SSL."""

from datetime import datetime, timedelta, timezone
import json

from confluent_kafka import KafkaException, Producer

from telemetry_sinks.common import kafka_producer_config
from telemetry_sinks.contracts import SCHEMA_DIR, _load_validators, parse_record


TOPIC = "greenguard.telemetry.recorded.v1"
TENANT = "11111111-1111-4111-8111-111111111111"
DEVICE = "22222222-2222-4222-8222-222222222222"
EVENT_ID = "33333333-3333-4333-8333-333333333333"
READING_ID = "44444444-4444-4444-8444-444444444444"
SITE = "55555555-5555-4555-8555-555555555555"
BIN = "66666666-6666-4666-8666-666666666666"
now = datetime.now(timezone.utc).replace(microsecond=0)
observed = now.isoformat().replace("+00:00", "Z")
received = (now + timedelta(seconds=1)).isoformat().replace("+00:00", "Z")
occurred = (now + timedelta(seconds=2)).isoformat().replace("+00:00", "Z")
event = {
    "event_id": EVENT_ID,
    "event_type": "telemetry.recorded",
    "schema_version": 1,
    "occurred_at": occurred,
    "tenant_id": TENANT,
    "aggregate_type": "device_telemetry_stream",
    "aggregate_id": DEVICE,
    "aggregate_version": "1",
    "correlation_id": EVENT_ID,
    "causation_id": EVENT_ID,
    "traceparent": "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    "payload": {
        "reading_id": READING_ID,
        "device_id": DEVICE,
        "site_id": SITE,
        "bin_id": BIN,
        "binding_version": "1",
        "source_message_id": "telemetry-pipeline-e2e",
        "observed_at": observed,
        "received_at": received,
        "measurements": {"temperature_c": 23.5, "relative_humidity_percent": 65.0},
    },
}
key = f"{TENANT}:{DEVICE}".encode()
value = json.dumps(event, separators=(",", ":"), allow_nan=False).encode()
parse_record(TOPIC, key, value, 0, 0, _load_validators(SCHEMA_DIR))
errors = []
producer = Producer(kafka_producer_config("greenguard-telemetry-pipeline-e2e"))
producer.produce(TOPIC, key=key, value=value, headers=[
    ("event_id", EVENT_ID.encode()),
    ("event_type", b"telemetry.recorded"),
    ("schema_version", b"1"),
    ("tenant_id", TENANT.encode()),
    ("correlation_id", EVENT_ID.encode()),
    ("traceparent", event["traceparent"].encode()),
], on_delivery=lambda error, _message: errors.append(error) if error else None)
if producer.flush(30):
    raise RuntimeError("local canonical telemetry fixture was not delivered")
if errors:
    raise KafkaException(errors[0])
print(json.dumps({"eventId": EVENT_ID, "topic": TOPIC}))
