"""Generate bounded synthetic events for Kafka-backed shadow scoring/analytics.

The fixture publishes only to a loopback Kafka broker. Independent production-
style ClickHouse and S3 consumers own their checkpoints and sink writes.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import math
import os
import socket
import time
import uuid

from confluent_kafka import Producer

TENANT = "0a0a0a0a-0000-4000-8000-00000000000a"
SITE = "0b0b0b0b-0000-4000-8000-00000000000b"
TOPIC = "greenguard.telemetry.recorded.v1"
SHADOW_TOPIC = "greenguard.ml.prediction.shadow.v1"
NAMESPACE = uuid.UUID("d6f7216d-533c-49f8-972a-1b2691986e59")


def local_endpoint(value: str, name: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "http" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(f"{name} must be a plain local HTTP URL")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(parsed.hostname, parsed.port or 80)}
    except OSError as exc:
        raise ValueError(f"{name} does not resolve") from exc
    if not addresses or any(not ipaddress_is_loopback(address) for address in addresses):
        raise ValueError(f"{name} must resolve only to loopback addresses")
    return value.rstrip("/")


def ipaddress_is_loopback(address: str) -> bool:
    import ipaddress
    return ipaddress.ip_address(address).is_loopback


def make_reading(run_id: str, bin_index: int, device_index: int, sequence: int,
                 observed_at: datetime, received_at: datetime) -> dict:
    bin_id = str(uuid.uuid5(NAMESPACE, f"{run_id}:bin:{bin_index}"))
    device_id = str(uuid.uuid5(NAMESPACE, f"{run_id}:bin:{bin_index}:sensor:{device_index}"))
    reading_id = str(uuid.uuid5(NAMESPACE, f"{run_id}:{bin_index}:{device_index}:{sequence}:reading"))
    event_id = str(uuid.uuid5(NAMESPACE, f"{run_id}:{bin_index}:{device_index}:{sequence}:event"))
    # First two bins model an elevated excursion; others remain in a stable band.
    excursion = bin_index < 2
    phase = sequence / 96 * math.tau
    sensor_offset = (device_index - 7.5) * 0.12
    temperature = (28.5 + 0.7 * sequence / 96 if excursion else 17.5) + math.sin(phase) * 1.3 + sensor_offset
    humidity = (74.0 + 1.5 * sequence / 96 if excursion else 56.0) + math.cos(phase) * 3.0 + sensor_offset
    temperature = round(temperature, 3)
    humidity = round(humidity, 3)
    ts = lambda value: value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    body = {
        "event_id": event_id, "event_type": "telemetry.recorded", "schema_version": 1,
        "occurred_at": ts(received_at), "tenant_id": TENANT,
        "aggregate_type": "device_telemetry_stream", "aggregate_id": device_id,
        "aggregate_version": str(sequence + 1),
        "correlation_id": str(uuid.uuid5(NAMESPACE, f"{run_id}:correlation:{bin_index}")),
        "causation_id": str(uuid.uuid5(NAMESPACE, f"{run_id}:cause:{bin_index}:{sequence}")),
        "traceparent": "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        "payload": {
            "reading_id": reading_id, "device_id": device_id, "site_id": SITE,
            "bin_id": bin_id, "binding_version": "1",
            "source_message_id": f"{run_id}:{bin_index}:{device_index}:{sequence}",
            "observed_at": ts(observed_at), "received_at": ts(received_at),
            "measurements": {"temperature_c": temperature,
                             "relative_humidity_percent": humidity},
        },
    }
    clickhouse_time = ts(observed_at).replace("T", " ").removesuffix("Z")
    return {"tenant_id": TENANT, "site_id": SITE, "bin_id": bin_id,
            "event_id": event_id, "device_id": device_id, "reading_id": reading_id,
            "schema_version": 1, "observed_at": clickhouse_time,
            "received_at": ts(received_at).replace("T", " ").removesuffix("Z"),
            "temperature_c": temperature, "relative_humidity_percent": humidity,
            "co2_ppm": None, "grain_moisture_percent": None,
            "source_topic": TOPIC, "source_partition": 0, "source_offset": sequence * 1000 + bin_index * 16 + device_index,
            "event_sha256": __import__("hashlib").sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            "simulated_risk_label": int(excursion and sequence >= 48),
            "data_origin": "synthetic_grain_sim", "seed_run": run_id,
            "kafka_key": f"{TENANT}:{device_id}", "kafka_value": body}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bins", type=int, default=8)
    parser.add_argument("--sensors-per-bin", type=int, default=16)
    parser.add_argument("--steps", type=int, default=96)
    parser.add_argument("--seed-run", default=None)
    parser.add_argument("--allow-local-synthetic", action="store_true")
    args = parser.parse_args()
    if not args.allow_local_synthetic:
        parser.error("pass --allow-local-synthetic to acknowledge this fixture is not real grain data")
    if not (1 <= args.bins <= 32 and args.sensors_per_bin == 16 and 24 <= args.steps <= 96):
        parser.error("bounds: bins 1–32, sensors-per-bin exactly 16, steps 24–96")
    brokers = local_endpoint("http://" + os.environ.get("ML_SEED_KAFKA", "127.0.0.1:59099"), "Kafka")
    parsed_broker = urllib.parse.urlsplit(brokers)
    if os.environ.get("ML_SYNTHETIC_TENANT_ID") != TENANT:
        parser.error("running scorer tenant does not match the fixture's synthetic allowlist")

    args.seed_run = args.seed_run or "local-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    now -= timedelta(minutes=now.minute % 15)
    start = now - timedelta(minutes=15 * (args.steps - 1))
    rows: list[dict] = []
    producer = Producer({"bootstrap.servers": f"{parsed_broker.hostname}:{parsed_broker.port}"})
    sent = 0
    for sequence in range(args.steps):
        observed_at = start + timedelta(minutes=15 * sequence)
        for bin_index in range(args.bins):
            for device_index in range(args.sensors_per_bin):
                received_at = datetime.now(timezone.utc)
                row = make_reading(args.seed_run, bin_index, device_index, sequence,
                                   observed_at, received_at)
                rows.append(row)
                producer.produce(TOPIC, key=row["kafka_key"].encode(),
                                 value=json.dumps(row["kafka_value"], separators=(",", ":")).encode())
                sent += 1
        producer.poll(0)
    remaining = producer.flush(60)
    if remaining:
        raise RuntimeError(f"Kafka did not accept {remaining} synthetic messages")
    print(json.dumps({"seed_run": args.seed_run, "tenant": TENANT,
                      "events_published": sent, "clickhouse_rows_inserted": "awaiting independent Kafka sink",
                      "bins": args.bins, "sensors_per_bin": args.sensors_per_bin,
                      "steps_per_sensor": args.steps, "hours_covered": (args.steps - 1) / 4,
                      "data_origin": "synthetic_grain_sim", "product_decisions_enabled": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
