"""Version-one inventory imports; this module never writes canonical state."""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from typing import Any, Mapping

CONTRACT_VERSION = 1
MAX_RECORD_BYTES = 65536
EVENT_NAMESPACE = uuid.UUID("a00f2290-bf1c-5eb9-b19a-54f3acb29355")
ENTITY_NAMESPACE = uuid.UUID("409d1c3b-a7ed-5fc4-830f-20373fb7e663")
ENTITY_TABLES = {"inventory_sites": "site", "inventory_bins": "bin", "inventory_devices": "device"}
ID_FIELDS = {"site": "site_id", "bin": "bin_id", "device": "device_id"}
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
TOPIC_PREFIX = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
FIELDS = {
    "site": {"tenant_key", "site_id", "name"},
    "bin": {"tenant_key", "bin_id", "site_id", "name"},
    "device": {"tenant_key", "device_id", "site_id", "bin_id", "serial_number", "status"},
}


class InvalidChange(ValueError):
    """Malformed/untrusted input must be quarantined by the eventual consumer."""


def _identifier(value: Any, field: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise InvalidChange(f"{field} must be a bounded source identifier")
    return value


def _text(value: Any, field: str, maximum: int) -> str:
    if (not isinstance(value, str) or not 1 <= len(value) <= maximum
            or value != value.strip(" ")
            or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value)):
        raise InvalidChange(f"{field} must be 1-{maximum} non-control characters")
    return value


def _integer(value: Any, field: str) -> int:
    if type(value) is not int or not 0 <= value <= 9223372036854775807:
        raise InvalidChange(f"{field} must be a nonnegative signed-64-bit integer")
    return value


def _json_object(raw: bytes, field: str) -> dict[str, Any]:
    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_RECORD_BYTES:
        raise InvalidChange(f"{field} must be bounded JSON bytes")

    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for name, value in pairs:
            if name in result:
                raise InvalidChange(f"{field} has duplicate JSON members")
            result[name] = value
        return result

    def reject_constant(value: str) -> None:
        raise InvalidChange(f"{field} has non-finite JSON values")

    try:
        parsed = json.loads(raw, object_pairs_hook=unique, parse_constant=reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise InvalidChange(f"{field} is not valid JSON") from exc
    if not isinstance(parsed, dict):
        raise InvalidChange(f"{field} envelope must be an object")
    if set(parsed) != {"schema", "payload"} or not isinstance(parsed.get("payload"), dict):
        raise InvalidChange(f"{field} must be a Debezium JSON-converter envelope")
    if parsed.get("schema") is not None and not isinstance(parsed["schema"], dict):
        raise InvalidChange(f"{field} schema must be an object or null")
    return parsed["payload"]


def _stable_uuid(namespace: uuid.UUID, parts: list[str | int]) -> str:
    # Structured encoding prevents separator collisions in external identifiers.
    return str(uuid.uuid5(namespace, json.dumps(parts, separators=(",", ":"))))


@dataclass(frozen=True)
class SourceConfig:
    """Trusted connector identity, not supplied by a partner event."""
    source_id: str
    connector_generation: str
    connector_name: str
    database: str
    topic_prefix: str

    def __post_init__(self) -> None:
        for field in ("source_id", "connector_generation", "connector_name", "database"):
            _identifier(getattr(self, field), field)
        if not isinstance(self.topic_prefix, str) or not TOPIC_PREFIX.fullmatch(self.topic_prefix):
            raise InvalidChange("topic_prefix is invalid")


@dataclass(frozen=True)
class SourceCoordinate:
    connector_generation: str
    topic: str
    partition: int
    offset: int


@dataclass(frozen=True)
class NormalizedChange:
    contract_version: int
    event_id: str
    source_id: str
    source_coordinate: SourceCoordinate
    tenant_id: str
    entity_type: str
    external_id: str
    entity_id: str
    operation: str
    payload: dict[str, Any]
    payload_sha256: str


def canonical_id(source_id: str, tenant_id: str, entity_type: str, external_id: str) -> str:
    _identifier(source_id, "source_id")
    _identifier(external_id, "external_id")
    if entity_type not in ID_FIELDS:
        raise InvalidChange("entity type is invalid")
    try:
        tenant = str(uuid.UUID(tenant_id))
    except (ValueError, TypeError, AttributeError) as exc:
        raise InvalidChange("tenant must be a canonical UUID") from exc
    return _stable_uuid(ENTITY_NAMESPACE, [source_id, tenant, entity_type, external_id])


def _row(row: Any, entity: str) -> dict[str, Any]:
    if not isinstance(row, dict) or set(row) != FIELDS[entity]:
        raise InvalidChange("row fields do not match the version-one source schema")
    for field in ("tenant_key", ID_FIELDS[entity]):
        _identifier(row[field], field)
    if entity != "site":
        _identifier(row["site_id"], "site_id")
    if entity == "device":
        if row["bin_id"] is not None:
            _identifier(row["bin_id"], "bin_id")
        _text(row["serial_number"], "serial_number", 128)
        if row["status"] not in ("active", "disabled", "deleted"):
            raise InvalidChange("device status is invalid")
    else:
        _text(row["name"], "name", 200)
    return row


def normalize_change(
    *, source_config: SourceConfig, topic: str, partition: int, offset: int,
    key: bytes, value: bytes, tenant_map: Mapping[str, str]
) -> NormalizedChange:
    """Validate a complete change and preserve its exact replay fence.

    Offsets compare only inside one generation/topic/partition. Kafka null-value
    tombstones are not deletes: the preceding delete carries the before image.
    """
    _integer(partition, "partition")
    _integer(offset, "offset")
    payload = _json_object(value, "value")
    source = payload.get("source")
    if not isinstance(source, dict):
        raise InvalidChange("change source is missing")
    table = source.get("table")
    entity = ENTITY_TABLES.get(table) if isinstance(table, str) else None
    if entity is None:
        raise InvalidChange("source table is not allowlisted")
    if (source.get("name") != source_config.connector_name
            or source.get("db") != source_config.database
            or source.get("connector") != "mysql"
            or topic != f"{source_config.topic_prefix}.{source_config.database}.{table}"):
        raise InvalidChange("source metadata does not match trusted configuration/topic")
    _identifier(source.get("file"), "source.file")
    _integer(source.get("pos"), "source.pos")
    _integer(source.get("row"), "source.row")
    _integer(source.get("ts_ms"), "source.ts_ms")
    _integer(payload.get("ts_ms"), "ts_ms")
    operation = payload.get("op")
    if operation not in ("r", "c", "u", "d"):
        raise InvalidChange("unsupported Debezium operation")
    snapshot = source.get("snapshot")
    if operation == "r":
        # Debezium 3.x emits first/last_in_data_collection for full snapshots;
        # older JSON converter fixtures used true/last. All are snapshot-only.
        if snapshot not in (True, "true", "first", "first_in_data_collection", "last_in_data_collection", "last") or type(snapshot) is int:
            raise InvalidChange("snapshot operation requires snapshot metadata")
    elif snapshot not in (False, "false") or type(snapshot) is int:
        raise InvalidChange("streaming operation requires non-snapshot metadata")
    if "before" not in payload or "after" not in payload:
        raise InvalidChange("both image fields must be explicit")
    if operation in ("r", "c"):
        if payload["before"] is not None:
            raise InvalidChange("create/snapshot before image must be null")
        row = _row(payload["after"], entity)
    elif operation == "d":
        if payload["after"] is not None:
            raise InvalidChange("delete after image must be null")
        row = _row(payload["before"], entity)
    else:
        before = _row(payload["before"], entity)
        row = _row(payload["after"], entity)
        if any(before[field] != row[field] for field in ("tenant_key", ID_FIELDS[entity])):
            raise InvalidChange("updates cannot change source tenant or entity identity")
        if entity == "bin" and before["site_id"] != row["site_id"]:
            raise InvalidChange("bin relocation is not supported by the import contract")
    expected_key = {field: row[field] for field in ("tenant_key", ID_FIELDS[entity])}
    if _json_object(key, "key") != expected_key:
        raise InvalidChange("Kafka key does not match the composite source identity")
    try:
        tenant_id = str(uuid.UUID(tenant_map[row["tenant_key"]]))
    except (KeyError, ValueError, TypeError, AttributeError) as exc:
        raise InvalidChange("source tenant is not explicitly mapped to a UUID") from exc
    external_id = row[ID_FIELDS[entity]]
    entity_id = canonical_id(source_config.source_id, tenant_id, entity, external_id)
    canonical_row: dict[str, Any] = {ID_FIELDS[entity]: entity_id}
    if entity != "site":
        canonical_row["site_id"] = canonical_id(source_config.source_id, tenant_id, "site", row["site_id"])
    if entity == "device":
        canonical_row["bin_id"] = (canonical_id(source_config.source_id, tenant_id, "bin", row["bin_id"])
                                   if row["bin_id"] is not None else None)
        canonical_row.update(serial_number=row["serial_number"], status=row["status"])
    else:
        canonical_row["name"] = row["name"]
    normalized_operation = "delete" if operation == "d" else "upsert"
    coordinate = SourceCoordinate(source_config.connector_generation, topic, partition, offset)
    # The receipt fence must detect changed source bytes at the *same* Kafka
    # coordinate, even when two source images normalize to one canonical row.
    digest = hashlib.sha256(
        len(key).to_bytes(4, "big") + key + len(value).to_bytes(4, "big") + value
    ).hexdigest()
    event_id = _stable_uuid(EVENT_NAMESPACE, [source_config.source_id, coordinate.connector_generation, topic, partition, offset])
    return NormalizedChange(CONTRACT_VERSION, event_id, source_config.source_id, coordinate, tenant_id,
                            entity, external_id, entity_id, normalized_operation, canonical_row, digest)
