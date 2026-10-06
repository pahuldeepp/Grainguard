"""Strict Kafka key, schema and cross-field validation for canonical telemetry."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker


TOPICS = {
    "greenguard.telemetry.recorded.v1": 1,
    "greenguard.telemetry.recorded.v2": 2,
}
TRACEPARENT = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$")
SCHEMA_DIR = Path(__file__).resolve().parents[3] / "contracts/events"
MAX_EVENT_BYTES = 1024 * 1024


class InvalidTelemetryEvent(ValueError):
    """A permanent producer/schema error; do not commit the Kafka offset."""


@dataclass(frozen=True)
class TelemetryRecord:
    topic: str
    partition: int
    offset: int
    event: dict[str, Any]
    canonical_json: str
    event_sha256: str
    raw_key: bytes
    raw_value: bytes


def _load_validators(schema_dir: Path) -> dict[int, Draft202012Validator]:
    validators = {}
    for topic, version in TOPICS.items():
        schema_path = schema_dir / f"telemetry-recorded.v{version}.schema.json"
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
            Draft202012Validator.check_schema(schema)
        except (OSError, json.JSONDecodeError, ValueError) as error:
            raise RuntimeError(f"canonical telemetry schema v{version} is missing or invalid") from error
        validators[version] = Draft202012Validator(schema, format_checker=FormatChecker())
    return validators


def parse_record(
    topic: str,
    key: bytes | None,
    value: bytes | None,
    partition: int,
    offset: int,
    validators: dict[int, Draft202012Validator],
) -> TelemetryRecord:
    version = TOPICS.get(topic)
    if version is None or not isinstance(value, bytes) or len(value) == 0 or len(value) > MAX_EVENT_BYTES:
        raise InvalidTelemetryEvent("unsupported topic or event size")
    if key is None or not isinstance(key, bytes):
        raise InvalidTelemetryEvent("Kafka record key is required")
    try:
        event = json.loads(value, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise InvalidTelemetryEvent("event is not UTF-8 JSON") from error
    if not isinstance(event, dict) or event.get("schema_version") != version:
        raise InvalidTelemetryEvent("topic and schema version do not match")
    try:
        aggregate_version = int(event["aggregate_version"])
        binding_version = int(event["payload"]["binding_version"])
    except (KeyError, TypeError, ValueError) as error:
        raise InvalidTelemetryEvent("event version is invalid") from error
    if aggregate_version > 9_223_372_036_854_775_807 or binding_version > 9_223_372_036_854_775_807:
        raise InvalidTelemetryEvent("event version exceeds PostgreSQL bigint range")
    errors = validators[version].iter_errors(event)
    if next(errors, None) is not None:
        raise InvalidTelemetryEvent("event does not satisfy the canonical schema")
    payload = event["payload"]
    if event["aggregate_id"] != payload["device_id"]:
        raise InvalidTelemetryEvent("aggregate identity does not match device identity")
    expected_key = f"{event['tenant_id']}:{payload['device_id']}".encode("ascii")
    if key != expected_key:
        raise InvalidTelemetryEvent("Kafka key does not match tenant and device identity")
    match = TRACEPARENT.fullmatch(event["traceparent"])
    if match is None or match.group(1) == "0" * 32 or match.group(2) == "0" * 16:
        raise InvalidTelemetryEvent("traceparent is invalid")
    try:
        occurred_at = _timestamp(event["occurred_at"])
        received_at = _timestamp(payload["received_at"])
        observed_at = _timestamp(payload["observed_at"])
    except (KeyError, ValueError, TypeError) as error:
        raise InvalidTelemetryEvent("event timestamp is invalid") from error
    if occurred_at < received_at or observed_at > received_at + timedelta(minutes=5):
        raise InvalidTelemetryEvent("event timestamps violate the canonical ordering")
    if type(partition) is not int or partition < 0 or type(offset) is not int or offset < 0:
        raise InvalidTelemetryEvent("Kafka source coordinates are invalid")
    try:
        canonical_json = json.dumps(event, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as error:
        raise InvalidTelemetryEvent("event contains a non-finite measurement") from error
    return TelemetryRecord(
        topic=topic,
        partition=partition,
        offset=offset,
        event=event,
        canonical_json=canonical_json,
        event_sha256=hashlib.sha256(value).hexdigest(),
        raw_key=key,
        raw_value=value,
    )


def _timestamp(value: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("UTC timestamp required")
    parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    if parsed.tzinfo != timezone.utc:
        raise ValueError("UTC timestamp required")
    return parsed


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON member")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise ValueError("non-finite JSON number")
