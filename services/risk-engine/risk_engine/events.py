"""Strict parsing of the canonical events the risk engine consumes.

Anything that does not match the v1 envelope or a known payload raises InvalidEvent
with a stable quarantine reason; nothing is guessed or defaulted.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping

TELEMETRY_TOPIC = "greenguard.telemetry.recorded.v1"
DEVICE_TOPIC = "greenguard.inventory.device.v1"
LOT_TOPIC = "greenguard.inventory.lot.v1"
TOPICS = (TELEMETRY_TOPIC, DEVICE_TOPIC, LOT_TOPIC)
CHECKPOINT_TYPE = "binding.feed_checkpoint"
DEVICE_EVENT_TYPES = ("device.registered", "device.binding_changed", "device.status_changed")

_UUID = re.compile(r"[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}", re.ASCII)
_VERSION = re.compile(r"[1-9]\d{0,18}", re.ASCII)
_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z", re.ASCII)
_TRACEPARENT = re.compile(r"00-[\da-f]{32}-[\da-f]{16}-(00|01)", re.ASCII)
_GRAIN = re.compile(r"[a-z][a-z0-9_-]{0,31}", re.ASCII)
_MAX_BIGINT = 9223372036854775807
_ENVELOPE_KEYS = frozenset({
    "event_id", "event_type", "schema_version", "occurred_at", "tenant_id", "aggregate_type",
    "aggregate_id", "aggregate_version", "correlation_id", "causation_id", "traceparent", "payload",
})


class InvalidEvent(ValueError):
    """A record that can never be applied; carries a stable quarantine reason."""

    def __init__(self, reason: str, detail: str):
        super().__init__(f"{reason}: {detail}")
        self.reason = reason


def _fail(detail: str) -> InvalidEvent:
    return InvalidEvent("invalid_event", detail)


def uuid_field(data: Mapping[str, Any], key: str, nullable: bool = False) -> str | None:
    value = data.get(key)
    if value is None and nullable and key in data:
        return None
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        raise _fail(f"{key} must be a lowercase UUID")
    return value


def version_field(data: Mapping[str, Any], key: str) -> int:
    value = data.get(key)
    if not isinstance(value, str) or not _VERSION.fullmatch(value) or int(value) > _MAX_BIGINT:
        raise _fail(f"{key} must be a positive bigint string")
    return int(value)


def parse_time(value: object, key: str) -> datetime:
    if not isinstance(value, str) or not _TIMESTAMP.fullmatch(value):
        raise _fail(f"{key} must be a UTC timestamp")
    whole, _, fraction = value[:-1].partition(".")
    # Python keeps microseconds; nanosecond input is truncated, never rounded forward.
    micros = (fraction + "000000")[:6] if fraction else "000000"
    try:
        return datetime.fromisoformat(f"{whole}.{micros}+00:00")
    except ValueError as exc:
        raise _fail(f"{key} is not a valid time") from exc


def format_time(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def canonical_sha256(event: Mapping[str, Any]) -> str:
    body = json.dumps(event, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Envelope:
    event_id: str
    event_type: str
    tenant_id: str
    aggregate_id: str
    aggregate_version: int
    correlation_id: str
    causation_id: str
    traceparent: str
    payload: Mapping[str, Any]
    raw: Mapping[str, Any]

    @property
    def sha256(self) -> str:
        return canonical_sha256(self.raw)


@dataclass(frozen=True)
class Telemetry:
    envelope: Envelope
    reading_id: str
    device_id: str
    bin_id: str | None
    binding_version: int
    observed_at: datetime
    measurements: Mapping[str, object]


@dataclass(frozen=True)
class BindingChange:
    envelope: Envelope
    device_id: str
    # Only the fields the event actually carries; absent fields keep local state.
    fields: Mapping[str, Any]
    binding_version: int


@dataclass(frozen=True)
class LotChange:
    envelope: Envelope
    bin_id: str
    site_id: str
    lot_id: str
    grain_type: str
    variety: str | None
    occupancy_version: int
    effective_from: datetime
    previous_lot_id: str | None


@dataclass(frozen=True)
class Checkpoint:
    """Transformer source checkpoint (ADR-0009); infrastructure data, no tenant."""

    source_time: datetime


def parse_envelope(event: Any) -> Envelope:
    if not isinstance(event, dict) or set(event) != _ENVELOPE_KEYS:
        raise _fail("envelope fields do not match v1")
    if event["schema_version"] != 1 or not isinstance(event["payload"], dict):
        raise _fail("unsupported schema version or payload")
    traceparent = event["traceparent"]
    if not isinstance(traceparent, str) or not _TRACEPARENT.fullmatch(traceparent):
        raise _fail("traceparent is not W3C version 00")
    parse_time(event["occurred_at"], "occurred_at")
    return Envelope(
        event_id=uuid_field(event, "event_id"), event_type=str(event["event_type"]),
        tenant_id=uuid_field(event, "tenant_id"), aggregate_id=uuid_field(event, "aggregate_id"),
        aggregate_version=version_field(event, "aggregate_version"),
        correlation_id=uuid_field(event, "correlation_id"),
        causation_id=uuid_field(event, "causation_id"), traceparent=traceparent,
        payload=event["payload"], raw=event,
    )


def _telemetry(envelope: Envelope) -> Telemetry:
    if envelope.event_type != "telemetry.recorded" or envelope.raw["aggregate_type"] != "device_telemetry_stream":
        raise InvalidEvent("unsupported_event", envelope.event_type)
    payload = envelope.payload
    device_id = uuid_field(payload, "device_id")
    if device_id != envelope.aggregate_id:
        raise _fail("aggregate_id must equal payload.device_id")
    measurements = payload.get("measurements")
    if not isinstance(measurements, dict) or not measurements:
        raise _fail("measurements must be a non-empty object")
    return Telemetry(
        envelope=envelope, reading_id=uuid_field(payload, "reading_id"), device_id=device_id,
        bin_id=uuid_field(payload, "bin_id", nullable=True),
        binding_version=version_field(payload, "binding_version"),
        observed_at=parse_time(payload.get("observed_at"), "observed_at"), measurements=measurements,
    )


def _binding(envelope: Envelope) -> BindingChange:
    if envelope.event_type not in DEVICE_EVENT_TYPES or envelope.raw["aggregate_type"] != "device":
        raise InvalidEvent("unsupported_event", envelope.event_type)
    payload = envelope.payload
    device_id = uuid_field(payload, "device_id")
    if device_id != envelope.aggregate_id:
        raise _fail("aggregate_id must equal payload.device_id")
    fields: dict[str, Any] = {}
    for key in ("site_id", "bin_id"):
        if key in payload:
            fields[key] = uuid_field(payload, key, nullable=True)
    if "status" in payload:
        status = payload["status"]
        if not isinstance(status, str) or not status:
            raise _fail("status must be a non-empty string")
        fields["status"] = status
    return BindingChange(envelope, device_id, fields, version_field(payload, "binding_version"))


def _lot(envelope: Envelope) -> LotChange:
    if envelope.event_type != "lot.changed" or envelope.raw["aggregate_type"] != "bin_occupancy":
        raise InvalidEvent("unsupported_event", envelope.event_type)
    payload = envelope.payload
    bin_id = uuid_field(payload, "bin_id")
    if bin_id != envelope.aggregate_id:
        raise _fail("aggregate_id must equal payload.bin_id")
    grain_type = payload.get("grain_type")
    if not isinstance(grain_type, str) or not _GRAIN.fullmatch(grain_type):
        raise _fail("grain_type is invalid")
    variety = payload.get("variety")
    if variety is not None and (not isinstance(variety, str) or not 1 <= len(variety) <= 100):
        raise _fail("variety is invalid")
    return LotChange(
        envelope=envelope, bin_id=bin_id, site_id=uuid_field(payload, "site_id"),
        lot_id=uuid_field(payload, "lot_id"), grain_type=grain_type, variety=variety,
        occupancy_version=version_field(payload, "occupancy_version"),
        effective_from=parse_time(payload.get("effective_from"), "effective_from"),
        previous_lot_id=uuid_field(payload, "previous_lot_id", nullable=True),
    )


_PARSERS = {TELEMETRY_TOPIC: _telemetry, DEVICE_TOPIC: _binding, LOT_TOPIC: _lot}


def parse(topic: str, value: bytes | None) -> Telemetry | BindingChange | LotChange | Checkpoint:
    if topic not in _PARSERS:
        raise InvalidEvent("unsupported_topic", topic)
    try:
        event = json.loads(value or b"")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _fail("record value is not JSON") from exc
    if topic == DEVICE_TOPIC and isinstance(event, dict) and event.get("event_type") == CHECKPOINT_TYPE:
        return Checkpoint(parse_time(event.get("source_time"), "source_time"))
    return _PARSERS[topic](parse_envelope(event))
