"""Strict parsing of the canonical events the risk engine consumes.

Anything that does not match the v1 envelope or a known payload raises InvalidEvent
with a stable quarantine reason; nothing is guessed or defaulted.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping

TELEMETRY_TOPIC = "greenguard.telemetry.recorded.v1"
TELEMETRY_V2_TOPIC = "greenguard.telemetry.recorded.v2"
DEVICE_TOPIC = "greenguard.inventory.device.v1"
LOT_TOPIC = "greenguard.inventory.lot.v1"
TOPICS = (TELEMETRY_TOPIC, TELEMETRY_V2_TOPIC, DEVICE_TOPIC, LOT_TOPIC)
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
    schema_version: int = 1
    sensor_observations: tuple[Mapping[str, Any], ...] = ()


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
    if (isinstance(event["schema_version"], bool) or event["schema_version"] not in (1, 2)
            or not isinstance(event["payload"], dict)):
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


_PHYSICAL_BOUNDS = {"temperature_c": (-80, 120), "relative_humidity_percent": (0, 100),
                    "co2_ppm": (0, float("inf")), "grain_moisture_percent": (0, 100)}
_EXPECTED_UNITS = {"temperature_c": "Cel", "relative_humidity_percent": "%",
                   "co2_ppm": "ppm", "grain_moisture_percent": "%"}


def _validate_measurement(key, value) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise _fail(f"{key} must be finite numeric")
    bounds = _PHYSICAL_BOUNDS[key]
    if not bounds[0] <= value <= bounds[1]:
        raise _fail(f"{key} is outside its physical range")


def _validate_v2_scalars(payload, measurements) -> None:
    required = {"reading_id", "device_id", "site_id", "bin_id", "binding_version",
                "source_message_id", "observed_at", "received_at", "measurements", "measurement_units"}
    if not required.issubset(payload) or set(payload) - required - {"sensor_observations"}:
        raise _fail("v2 telemetry payload fields do not match contract")
    if set(measurements) - {"temperature_c", "relative_humidity_percent", "co2_ppm", "grain_moisture_percent"}:
        raise _fail("unsupported v2 measurement")
    units = payload.get("measurement_units")
    if not isinstance(units, dict) or set(units) != set(measurements):
        raise _fail("measurement_units must exactly match measured fields")
    if any(units[key] != _EXPECTED_UNITS[key] for key in measurements):
        raise _fail("measurement unit mismatch")
    for key, value in measurements.items():
        _validate_measurement(key, value)
    uuid_field(payload, "site_id")
    message_id = payload.get("source_message_id")
    if not isinstance(message_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", message_id):
        raise _fail("source_message_id is invalid")
    parse_time(payload.get("received_at"), "received_at")


def _validate_sensor_position(observation) -> None:
    position = observation.get("position")
    depth = observation.get("depth_m")
    if isinstance(position, bool) or not isinstance(position, int) or position < 1:
        raise _fail("sensor position must be a positive integer")
    if depth is not None and (isinstance(depth, bool) or not isinstance(depth, (int, float))
                              or not math.isfinite(depth) or depth < 0):
        raise _fail("sensor depth must be finite and nonnegative")


def _validate_sensor_observation(observation):
    if not isinstance(observation, dict):
        raise _fail("sensor observation must be an object")
    sensor_id = uuid_field(observation, "sensor_id")
    metric = observation.get("metric")
    unit = observation.get("unit")
    if set(observation) != {"sensor_id", "metric", "value", "unit", "layout_version", "cable_id", "position", "depth_m"}:
        raise _fail("sensor observation fields do not match contract")
    uuid_field(observation, "cable_id")
    version_field(observation, "layout_version")
    _validate_sensor_position(observation)
    value = observation.get("value")
    if not isinstance(metric, str) or metric not in _EXPECTED_UNITS or unit != _EXPECTED_UNITS[metric]:
        raise _fail("sensor observation metric/unit mismatch")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise _fail("sensor observation value must be finite")
    bounds = _PHYSICAL_BOUNDS[metric]
    if not bounds[0] <= value <= bounds[1]:
        raise _fail("sensor observation is outside its physical range")
    return sensor_id, metric


def _v2_observations(payload, measurements):
    raw_observations = payload.get("sensor_observations", [])
    if not isinstance(raw_observations, list) or len(raw_observations) > 256:
        raise _fail("sensor_observations must be an array of at most 256 items")
    seen: set[tuple[str, str]] = set()
    for observation in raw_observations:
        identity = _validate_sensor_observation(observation)
        if identity in seen:
            raise _fail("duplicate sensor observation")
        seen.add(identity)
    if not measurements and not raw_observations:
        raise _fail("v2 telemetry requires measurements or sensor observations")
    return tuple(raw_observations)


def _telemetry(envelope: Envelope) -> Telemetry:
    if envelope.event_type != "telemetry.recorded" or envelope.raw["aggregate_type"] != "device_telemetry_stream":
        raise InvalidEvent("unsupported_event", envelope.event_type)
    payload = envelope.payload
    device_id = uuid_field(payload, "device_id")
    if device_id != envelope.aggregate_id:
        raise _fail("aggregate_id must equal payload.device_id")
    measurements = payload.get("measurements")
    if not isinstance(measurements, dict):
        raise _fail("measurements must be a non-empty object")
    if envelope.raw["schema_version"] == 1:
        if not measurements:
            raise _fail("measurements must be a non-empty object")
        observations: tuple[Mapping[str, Any], ...] = ()
    else:
        if envelope.raw["schema_version"] != 2:
            raise InvalidEvent("unsupported_event", "telemetry schema version")
        _validate_v2_scalars(payload, measurements)
        observations = _v2_observations(payload, measurements)
    return Telemetry(
        envelope=envelope, reading_id=uuid_field(payload, "reading_id"), device_id=device_id,
        bin_id=uuid_field(payload, "bin_id", nullable=True),
        binding_version=version_field(payload, "binding_version"),
        observed_at=parse_time(payload.get("observed_at"), "observed_at"), measurements=measurements,
        schema_version=int(envelope.raw["schema_version"]), sensor_observations=observations,
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


_PARSERS = {TELEMETRY_TOPIC: _telemetry, TELEMETRY_V2_TOPIC: _telemetry,
            DEVICE_TOPIC: _binding, LOT_TOPIC: _lot}


def parse(topic: str, value: bytes | None) -> Telemetry | BindingChange | LotChange | Checkpoint:
    if topic not in _PARSERS:
        raise InvalidEvent("unsupported_topic", topic)
    try:
        event = json.loads(value or b"")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _fail("record value is not JSON") from exc
    if topic == DEVICE_TOPIC and isinstance(event, dict) and event.get("event_type") == CHECKPOINT_TYPE:
        return Checkpoint(parse_time(event.get("source_time"), "source_time"))
    envelope = parse_envelope(event)
    if topic == TELEMETRY_TOPIC and event.get("schema_version") != 1:
        raise InvalidEvent("unsupported_event", "v1 topic requires schema version 1")
    if topic == TELEMETRY_V2_TOPIC and event.get("schema_version") != 2:
        raise InvalidEvent("unsupported_event", "v2 topic requires schema version 2")
    if topic in (DEVICE_TOPIC, LOT_TOPIC) and event.get("schema_version") != 1:
        raise InvalidEvent("unsupported_event", "inventory topic requires schema version 1")
    return _PARSERS[topic](envelope)
