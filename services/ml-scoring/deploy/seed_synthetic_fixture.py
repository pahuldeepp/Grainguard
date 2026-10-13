"""Publish bounded synthetic telemetry only to the isolated scorer topic."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
import uuid

from confluent_kafka import Producer


TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
DEVICE_NAMESPACE = uuid.UUID("11111111-1111-4111-8111-111111111111")
SITE = "22222222-2222-4222-8222-222222222222"
BIN = "33333333-3333-4333-8333-333333333333"
INPUT_TOPIC = "greenguard.telemetry.recorded.v1"
BOOTSTRAP = "kafka.ml-synthetic.svc.cluster.local:9093"
GROUP_CORRELATION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
GROUP_CAUSATION = "ffffffff-ffff-4fff-8fff-ffffffffffff"
TRACEPARENT = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"


SENSOR_COUNT = 16
READINGS_PER_SENSOR = 24


def _event(run_id: str, sequence: int, sensor_index: int, step: int, start: datetime) -> tuple[bytes, bytes]:
    device = str(uuid.uuid5(DEVICE_NAMESPACE, f"synthetic-sensor-{sensor_index:02d}"))
    observed = start + timedelta(minutes=15 * step)
    timestamp = observed.isoformat(timespec="seconds").replace("+00:00", "Z")
    event_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"ml-synthetic:{run_id}:{sequence}"))
    reading_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"ml-synthetic-reading:{run_id}:{sequence}"))
    body = {
        "event_id": event_id,
        "event_type": "telemetry.recorded",
        "schema_version": 1,
        "occurred_at": timestamp,
        "tenant_id": TENANT,
        "aggregate_type": "device_telemetry_stream",
        "aggregate_id": device,
        "aggregate_version": str(step + 1),
        "correlation_id": GROUP_CORRELATION,
        "causation_id": GROUP_CAUSATION,
        "traceparent": TRACEPARENT,
        "payload": {
            "reading_id": reading_id,
            "device_id": device,
            "site_id": SITE,
            "bin_id": BIN,
            "binding_version": "1",
            "source_message_id": f"ml-synthetic:{run_id}:{sequence}",
            "observed_at": timestamp,
            "received_at": timestamp,
            "measurements": {
                "temperature_c": 17.0 + sensor_index * 0.08 + 0.025 * step,
                "relative_humidity_percent": 57.0 + sensor_index * 0.1 + 0.018 * step,
            },
        },
    }
    key = f"{TENANT}:{device}".encode("ascii")
    return key, json.dumps(body, separators=(",", ":")).encode("utf-8")


def main() -> None:
    if os.environ.get("ML_ENVIRONMENT") != "cluster-synthetic":
        raise SystemExit("refusing fixture publish outside cluster-synthetic")
    if os.environ.get("KAFKA_BOOTSTRAP_SERVERS") != BOOTSTRAP:
        raise SystemExit("refusing fixture publish to a non-synthetic broker")
    if os.environ.get("KAFKA_SECURITY_PROTOCOL") != "SASL_SSL":
        raise SystemExit("synthetic fixture producer requires SASL_SSL")
    if os.environ.get("KAFKA_SASL_MECHANISM") != "SCRAM-SHA-512":
        raise SystemExit("synthetic fixture producer requires SCRAM-SHA-512")
    ca = os.environ.get("KAFKA_SSL_CA_LOCATION", "")
    if not ca or not os.path.isfile(ca):
        raise SystemExit("a mounted synthetic Kafka CA certificate is required")
    try:
        count = int(os.environ.get("SYNTHETIC_FIXTURE_COUNT", "384"))
    except ValueError as exc:
        raise SystemExit("SYNTHETIC_FIXTURE_COUNT must be an integer") from exc
    if count != SENSOR_COUNT * READINGS_PER_SENSOR:
        raise SystemExit("SYNTHETIC_FIXTURE_COUNT must be exactly 384 (16 sensors × 24 history intervals)")

    producer = Producer({
        "bootstrap.servers": BOOTSTRAP,
        "security.protocol": "SASL_SSL",
        "sasl.mechanism": "SCRAM-SHA-512",
        "sasl.username": os.environ.get("KAFKA_SASL_USERNAME", ""),
        "sasl.password": os.environ.get("KAFKA_SASL_PASSWORD", ""),
        "ssl.ca.location": ca,
        "enable.idempotence": True,
        "acks": "all",
        "message.timeout.ms": 15000,
    })
    run_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    start = now - timedelta(minutes=15 * (READINGS_PER_SENSOR - 1))
    sequence_base = int(now.timestamp()) // 900
    delivered = 0
    failure: list[Exception] = []

    def on_delivery(error, _message) -> None:
        nonlocal delivered
        if error is not None:
            failure.append(RuntimeError("synthetic fixture Kafka delivery failed"))
        else:
            delivered += 1

    for step in range(READINGS_PER_SENSOR):
        for sensor_index in range(SENSOR_COUNT):
            sequence = sequence_base + step * SENSOR_COUNT + sensor_index
            key, value = _event(run_id, sequence, sensor_index, step, start)
            producer.produce(INPUT_TOPIC, key=key, value=value, on_delivery=on_delivery)
            producer.poll(0)
    remaining = producer.flush(20)
    if remaining or failure or delivered != count:
        raise SystemExit(
            f"synthetic fixture publish incomplete: delivered={delivered}, remaining={remaining}"
        )
    print(f"published {delivered} synthetic fixture events to the isolated shadow input topic")


if __name__ == "__main__":
    main()
