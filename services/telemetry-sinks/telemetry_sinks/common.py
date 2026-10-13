from __future__ import annotations

import base64
import hashlib
import json
import os
from datetime import datetime, timezone

TOPICS = ("greenguard.telemetry.recorded.v1", "greenguard.telemetry.recorded.v2")


def kafka_consumer_config(group_id: str, client_id: str) -> dict:
    protocol = os.getenv("KAFKA_SECURITY_PROTOCOL", "SASL_SSL")
    config = {
        "bootstrap.servers": os.environ["KAFKA_BROKERS"],
        "group.id": group_id,
        "client.id": client_id,
        "enable.auto.commit": False,
        "enable.auto.offset.store": False,
        "auto.offset.reset": os.getenv("KAFKA_AUTO_OFFSET_RESET", "earliest"),
        "security.protocol": protocol,
    }
    if protocol.startswith("SASL_"):
        username, password = os.getenv("KAFKA_SASL_USERNAME"), os.getenv("KAFKA_SASL_PASSWORD")
        mechanism = os.getenv("KAFKA_SASL_MECHANISM", "PLAIN")
        if not username or not password or mechanism not in ("PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"):
            raise RuntimeError("SASL Kafka requires a username, password, and supported mechanism")
        config.update({"sasl.mechanism": mechanism, "sasl.username": username, "sasl.password": password})
    if protocol.endswith("SSL"):
        ca_file = os.getenv("KAFKA_TLS_CA_FILE")
        if ca_file:
            config["ssl.ca.location"] = ca_file
    return config


def kafka_producer_config(client_id: str) -> dict:
    protocol = os.getenv("KAFKA_SECURITY_PROTOCOL", "SASL_SSL")
    config = {
        "bootstrap.servers": os.environ["KAFKA_BROKERS"],
        "client.id": client_id,
        "enable.idempotence": True,
        "security.protocol": protocol,
    }
    if protocol.startswith("SASL_"):
        username, password = os.getenv("KAFKA_SASL_USERNAME"), os.getenv("KAFKA_SASL_PASSWORD")
        mechanism = os.getenv("KAFKA_SASL_MECHANISM", "PLAIN")
        if not username or not password or mechanism not in ("PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"):
            raise RuntimeError("SASL Kafka requires a username, password, and supported mechanism")
        config.update({"sasl.mechanism": mechanism, "sasl.username": username, "sasl.password": password})
    if protocol.endswith("SSL"):
        ca_file = os.getenv("KAFKA_TLS_CA_FILE")
        if ca_file:
            config["ssl.ca.location"] = ca_file
    return config


def archive_record(topic: str, partition: int, offset: int, key: bytes | None,
                   value: bytes, timestamp_ms: int | None,
                   headers: list[tuple[str, bytes | None]] | None = None) -> tuple[bytes, str]:
    digest = hashlib.sha256((key or b"") + b"\0" + value).hexdigest()
    encoded_headers = [{"name": name, "value_base64": base64.b64encode(header_value or b"").decode("ascii")}
                       for name, header_value in (headers or [])]
    header_bytes = json.dumps(encoded_headers, sort_keys=True, separators=(",", ":")).encode()
    record = {
        "format_version": 1, "topic": topic, "partition": partition, "offset": offset,
        "timestamp_ms": timestamp_ms,
        "key_base64": base64.b64encode(key or b"").decode("ascii"),
        "value_base64": base64.b64encode(value).decode("ascii"),
        "headers": encoded_headers,
        "headers_sha256": hashlib.sha256(header_bytes).hexdigest(),
        "sha256": digest,
    }
    return json.dumps(record, sort_keys=True, separators=(",", ":")).encode(), digest


def archive_key(topic: str, partition: int, offset: int, timestamp_ms: int | None) -> str:
    instant = datetime.fromtimestamp((timestamp_ms or 0) / 1000, tz=timezone.utc)
    safe_topic = topic.replace("/", "_")
    return (f"telemetry/{safe_topic}/date={instant:%Y-%m-%d}/"
            f"partition={partition:05d}/offset={offset:020d}.json")


def clickhouse_row(raw: bytes, topic: str, partition: int, offset: int) -> dict:
    event = json.loads(raw)
    if not isinstance(event, dict) or event.get("event_type") != "telemetry.recorded":
        raise ValueError("not a telemetry.recorded event")
    if event.get("schema_version") not in (1, 2):
        raise ValueError("unsupported telemetry schema version")
    payload = event.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("telemetry payload is missing")
    measurements = payload.get("measurements")
    if not isinstance(measurements, dict):
        raise ValueError("telemetry measurements are missing")
    def clickhouse_datetime(value: str) -> str:
        # ClickHouse DateTime64 JSONEachRow accepts its canonical UTC textual
        # representation (space separator, no RFC3339 zone suffix).
        instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if instant.tzinfo is None:
            raise ValueError("telemetry timestamp must include a timezone")
        return instant.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]

    row = {
        "event_id": event["event_id"], "tenant_id": event["tenant_id"],
        "site_id": payload.get("site_id"), "bin_id": payload.get("bin_id"),
        "device_id": payload["device_id"], "reading_id": payload["reading_id"],
        "schema_version": event["schema_version"],
        "observed_at": clickhouse_datetime(payload["observed_at"]),
        "received_at": clickhouse_datetime(payload["received_at"]),
        "source_topic": topic, "source_partition": partition, "source_offset": offset,
        "event_sha256": hashlib.sha256(raw).hexdigest(),
    }
    for metric in ("temperature_c", "relative_humidity_percent", "co2_ppm", "grain_moisture_percent"):
        row[metric] = measurements.get(metric)
    return row
