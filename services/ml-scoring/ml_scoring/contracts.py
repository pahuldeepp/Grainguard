"""Strict validation for the canonical telemetry.recorded v1 envelope."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import re
import uuid
from typing import Any


class ContractError(ValueError):
    """Input does not satisfy the immutable canonical event contract."""


_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_KEY = re.compile(r"^(?P<tenant>[0-9a-f-]{36}):(?P<device>[0-9a-f-]{36})$")
_TRACEPARENT = re.compile(r"^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$")
_UTC_TIMESTAMP = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$")
_SOURCE_MESSAGE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_MAX_BIGINT = 9_223_372_036_854_775_807
_POSITIVE_BIGINT = re.compile(r"^[1-9][0-9]{0,18}$")


def _uuid(value: Any, field: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        raise ContractError(f"{field} must be a canonical lowercase UUID")
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError
    except ValueError as exc:
        raise ContractError(f"{field} must be a valid UUID") from exc
    return value


def parse_canonical_uuid(value: Any, field: str) -> str:
    """Validate a configured or event UUID using the canonical envelope rule."""
    parsed = _uuid(value, field)
    if parsed is None:
        raise ContractError(f"{field} must be a canonical lowercase UUID")
    return parsed


def _positive_bigint(value: Any, field: str) -> int:
    if not isinstance(value, str) or not _POSITIVE_BIGINT.fullmatch(value):
        raise ContractError(f"{field} must be a positive PostgreSQL bigint string")
    parsed = int(value)
    if parsed > _MAX_BIGINT:
        raise ContractError(f"{field} must be a positive PostgreSQL bigint string")
    return parsed


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not _UTC_TIMESTAMP.fullmatch(value):
        raise ContractError(f"{field} must be a UTC ISO-8601 timestamp ending in Z")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ContractError(f"{field} is not a valid ISO-8601 timestamp") from exc
    if parsed.tzinfo != timezone.utc:
        raise ContractError(f"{field} must be UTC")
    if not 2000 <= parsed.year <= 2200:
        raise ContractError(f"{field} is outside the supported timestamp range")
    return parsed


@dataclass(frozen=True)
class TelemetryEvent:
    event_id: str
    tenant_id: str
    device_id: str
    bin_id: str | None
    source_message_id: str
    sequence: int
    observed_at: datetime
    received_at: datetime
    temperature_c: float | None
    relative_humidity_percent: float | None
    correlation_id: str
    causation_id: str
    traceparent: str
    digest: str


def parse_telemetry_recorded(key: bytes | str | None, raw: bytes | str) -> TelemetryEvent:
    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        envelope = json.loads(text)
    except (UnicodeDecodeError, ValueError, TypeError, RecursionError) as exc:
        raise ContractError("event value must be UTF-8 JSON") from exc
    if not isinstance(envelope, dict):
        raise ContractError("event value must be a JSON object")
    envelope_fields = {
        "event_id", "event_type", "schema_version", "occurred_at", "tenant_id",
        "aggregate_type", "aggregate_id", "aggregate_version", "correlation_id",
        "causation_id", "traceparent", "payload",
    }
    if set(envelope) != envelope_fields:
        raise ContractError("event envelope fields do not match telemetry.recorded v1")
    schema_version = envelope.get("schema_version")
    if envelope.get("event_type") != "telemetry.recorded" or type(schema_version) is not int or schema_version != 1:
        raise ContractError("only telemetry.recorded schema_version 1 is accepted")
    event_id = _uuid(envelope.get("event_id"), "event_id")
    tenant_id = _uuid(envelope.get("tenant_id"), "tenant_id")
    aggregate_id = _uuid(envelope.get("aggregate_id"), "aggregate_id")
    if envelope.get("aggregate_type") != "device_telemetry_stream":
        raise ContractError("aggregate_type must be device_telemetry_stream")
    version = _positive_bigint(envelope.get("aggregate_version"), "aggregate_version")
    correlation_id = _uuid(envelope.get("correlation_id"), "correlation_id")
    causation_id = _uuid(envelope.get("causation_id"), "causation_id")
    occurred_at = _timestamp(envelope.get("occurred_at"), "occurred_at")
    traceparent = envelope.get("traceparent")
    if not isinstance(traceparent, str) or not _TRACEPARENT.fullmatch(traceparent):
        raise ContractError("traceparent must be W3C trace-context v00")
    if traceparent[3:35] == "0" * 32 or traceparent[36:52] == "0" * 16:
        raise ContractError("traceparent trace and parent IDs must be non-zero")
    payload = envelope.get("payload")
    if not isinstance(payload, dict):
        raise ContractError("payload must be an object")
    payload_fields = {
        "reading_id", "device_id", "site_id", "bin_id", "binding_version",
        "source_message_id", "observed_at", "received_at", "measurements",
    }
    if set(payload) != payload_fields:
        raise ContractError("payload fields do not match telemetry.recorded v1")
    _uuid(payload.get("reading_id"), "payload.reading_id")
    device_id = _uuid(payload.get("device_id"), "payload.device_id")
    if device_id != aggregate_id:
        raise ContractError("aggregate_id must match payload.device_id")
    site_id = _uuid(payload.get("site_id"), "payload.site_id")
    del site_id
    bin_id = _uuid(payload.get("bin_id"), "payload.bin_id", nullable=True)
    _positive_bigint(payload.get("binding_version"), "binding_version")
    source_message_id = payload.get("source_message_id")
    if not isinstance(source_message_id, str) or not _SOURCE_MESSAGE_ID.fullmatch(source_message_id):
        raise ContractError("source_message_id does not match the canonical contract")
    measurements = payload.get("measurements")
    if not isinstance(measurements, dict) or not measurements:
        raise ContractError("payload.measurements must be a non-empty object")
    if set(measurements) - {"temperature_c", "relative_humidity_percent"}:
        raise ContractError("payload.measurements contains an unsupported sensor metric")
    parsed_measurements: dict[str, float | None] = {}
    limits = {"temperature_c": (-80.0, 120.0), "relative_humidity_percent": (0.0, 100.0)}
    for name, value in measurements.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ContractError(f"measurement {name} must be a finite number")
        try:
            numeric = float(value)
        except (OverflowError, ValueError) as exc:
            raise ContractError(f"measurement {name} must be a finite number") from exc
        if not math.isfinite(numeric):
            raise ContractError(f"measurement {name} must be a finite number")
        low, high = limits[name]
        if not low <= numeric <= high:
            raise ContractError(f"measurement {name} is outside the canonical contract range")
        parsed_measurements[name] = numeric
    observed_at = _timestamp(payload.get("observed_at"), "payload.observed_at")
    received_at = _timestamp(payload.get("received_at"), "payload.received_at")
    if occurred_at < received_at:
        raise ContractError("occurred_at cannot precede payload.received_at")
    if received_at > datetime.now(timezone.utc) + timedelta(minutes=5):
        raise ContractError("payload.received_at is too far in the future")
    if observed_at > received_at + timedelta(minutes=5):
        raise ContractError("payload.observed_at is too far after payload.received_at")
    if key is None:
        raise ContractError("Kafka key is required")
    try:
        kafka_key = key.decode("utf-8") if isinstance(key, bytes) else key
    except UnicodeDecodeError as exc:
        raise ContractError("Kafka key must be UTF-8") from exc
    key_match = _KEY.fullmatch(kafka_key) if isinstance(kafka_key, str) else None
    if not key_match or key_match.group("tenant") != tenant_id or key_match.group("device") != device_id:
        raise ContractError("Kafka key must match tenant_id:device_id from the event")
    canonical = json.dumps(envelope, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return TelemetryEvent(
        event_id=event_id, tenant_id=tenant_id, device_id=device_id, bin_id=bin_id,
        source_message_id=source_message_id, sequence=version, observed_at=observed_at,
        received_at=received_at, temperature_c=parsed_measurements.get("temperature_c"),
        relative_humidity_percent=parsed_measurements.get("relative_humidity_percent"),
        correlation_id=correlation_id, causation_id=causation_id,
        traceparent=traceparent, digest=hashlib.sha256(canonical).hexdigest(),
    )
