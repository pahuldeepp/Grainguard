"""Validate a private real telemetry + adjudicated outcome dataset package.

Checks declared provenance and data contracts; cannot prove source truth or
scientific validity. This command never trains or promotes a model.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sys
from typing import Any

class IntakeError(ValueError):
    pass

def _text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or "REPLACE_" in value:
        raise IntakeError(f"{field} must be populated (template placeholders are rejected)")
    return value.strip()

def _utc(value: Any, field: str) -> datetime:
    if not isinstance(value, str):
        raise IntakeError(f"{field} must be an ISO-8601 UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise IntakeError(f"{field} is not a valid ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise IntakeError(f"{field} must include UTC timezone")
    return parsed.astimezone(timezone.utc)

def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

def _file(root: Path, name: Any) -> Path:
    if not isinstance(name, str) or not name or Path(name).is_absolute():
        raise IntakeError("manifest file paths must be relative")
    path = (root / name).resolve()
    if root.resolve() not in path.parents or not path.is_file():
        raise IntakeError(f"file must exist inside dataset root: {name}")
    return path

def _jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8") as stream:
        for n, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise IntakeError(f"{path.name}:{n}: invalid JSON") from exc
            if not isinstance(row, dict):
                raise IntakeError(f"{path.name}:{n}: expected a JSON object")
            rows.append(row)
            if len(rows) > 2_000_000:
                raise IntakeError(f"{path.name} exceeds 2,000,000 rows")
    if not rows:
        raise IntakeError(f"{path.name} is empty")
    return rows

def validate_dataset(root: Path) -> dict[str, Any]:
    root = root.resolve()
    mp = root / "manifest.json"
    try:
        manifest = json.loads(mp.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise IntakeError("manifest.json is missing or invalid") from exc
    if not isinstance(manifest, dict) or manifest.get("contract_version") != "real-outcomes-v1":
        raise IntakeError("contract_version must be real-outcomes-v1")
    if manifest.get("data_origin") != "owner_authorized_real" or manifest.get("synthetic_only") is not False:
        raise IntakeError("only explicitly owner-authorized real data is accepted")
    for key in ("dataset_id", "source_system", "collection_owner", "authorization_reference",
                "outcome_definition", "outcome_adjudication_source", "units_and_calibration_reference"):
        _text(manifest.get(key), key)
    if manifest.get("direct_identifiers_removed") is not True:
        raise IntakeError("direct_identifiers_removed must be true")
    if type(manifest.get("retention_days")) is not int or manifest["retention_days"] < 1:
        raise IntakeError("retention_days must be a positive integer")
    window = manifest.get("observation_window")
    if not isinstance(window, dict):
        raise IntakeError("observation_window is required")
    start, end = _utc(window.get("start_utc"), "observation_window.start_utc"), _utc(window.get("end_utc"), "observation_window.end_utc")
    if start >= end:
        raise IntakeError("observation window start must precede end")
    horizon = manifest.get("outcome_horizon_hours")
    if type(horizon) is not int or not 1 <= horizon <= 8760:
        raise IntakeError("outcome_horizon_hours must be an integer from 1 to 8760")
    files = manifest.get("files")
    if not isinstance(files, dict):
        raise IntakeError("files must declare telemetry and outcomes")
    paths = {}
    for name in ("telemetry", "outcomes"):
        entry = files.get(name)
        if not isinstance(entry, dict):
            raise IntakeError(f"files.{name} must include path and sha256")
        path = _file(root, entry.get("path"))
        if not re.fullmatch(r"[0-9a-f]{64}", str(entry.get("sha256", ""))) or _sha(path) != entry["sha256"]:
            raise IntakeError(f"files.{name} checksum is invalid")
        paths[name] = path
    telemetry, outcomes = _jsonl(paths["telemetry"]), _jsonl(paths["outcomes"])
    seen_events, entities, lots_by_entity = set(), defaultdict(set), defaultdict(set)
    available_readings_by_lot = defaultdict(list)
    for n, row in enumerate(telemetry, 1):
        for key in ("event_id", "tenant_id", "site_id", "bin_id", "lot_id", "device_id", "harvest_year"):
            _text(row.get(key), f"telemetry[{n}].{key}")
        if row["event_id"] in seen_events:
            raise IntakeError(f"duplicate event_id: {row['event_id']}")
        seen_events.add(row["event_id"])
        observed, received = _utc(row.get("observed_at"), f"telemetry[{n}].observed_at"), _utc(row.get("received_at"), f"telemetry[{n}].received_at")
        if not start <= observed <= end or received < observed:
            raise IntakeError(f"telemetry[{n}] outside time window or received before observed")
        values = row.get("measurements")
        if not isinstance(values, dict) or not values or any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) for v in values.values()):
            raise IntakeError(f"telemetry[{n}].measurements must be non-empty numeric values")
        entity_key = (row["tenant_id"], row["site_id"], row["bin_id"], row["harvest_year"])
        entities[entity_key].add(observed)
        lots_by_entity[entity_key].add(row["lot_id"])
        available_readings_by_lot[(*entity_key, row["lot_id"])].append((observed, received))
    splits = manifest.get("splits")
    if not isinstance(splits, dict) or set(splits) != {"train", "validation", "test"}:
        raise IntakeError("splits must declare train, validation, and test")
    split_entity, sites, years = {}, defaultdict(set), defaultdict(set)
    for split, rows in splits.items():
        if not isinstance(rows, list) or not rows:
            raise IntakeError(f"splits.{split} must be non-empty")
        for row in rows:
            if not isinstance(row, dict):
                raise IntakeError(f"splits.{split} entries must be objects")
            site, bin_id = _text(row.get("site_id"), "split.site_id"), _text(row.get("bin_id"), "split.bin_id")
            harvest_year = _text(row.get("harvest_year"), "split.harvest_year")
            entity = (site, bin_id, harvest_year)
            if entity in split_entity:
                raise IntakeError(f"site/bin crosses splits: {site}/{bin_id}")
            split_entity[entity] = split
            sites[split].add(site)
            years[split].add(harvest_year)
    telemetry_entities = {(site, bin_id, year) for _, site, bin_id, year in entities}
    if telemetry_entities != set(split_entity):
        raise IntakeError("split declarations must cover exactly all telemetry site/bin/harvest-year entities")
    site_held = all(sites[a].isdisjoint(sites[b]) for a, b in (("train", "validation"), ("train", "test"), ("validation", "test")))
    year_held = all(years[a].isdisjoint(years[b]) for a, b in (("train", "validation"), ("train", "test"), ("validation", "test")))
    if not (site_held or year_held):
        raise IntakeError("hold out complete sites or complete harvest/weather years across all splits")
    seen_outcomes, labelled = set(), set()
    for n, row in enumerate(outcomes, 1):
        for key in ("outcome_id", "tenant_id", "site_id", "bin_id", "lot_id", "harvest_year", "label_name", "adjudication_reference"):
            _text(row.get(key), f"outcomes[{n}].{key}")
        if row["outcome_id"] in seen_outcomes:
            raise IntakeError(f"duplicate outcome_id: {row['outcome_id']}")
        seen_outcomes.add(row["outcome_id"])
        if row["label_name"] != "spoilage_within_horizon" or not isinstance(row.get("label_value"), bool):
            raise IntakeError(f"outcomes[{n}] must be an adjudicated boolean spoilage_within_horizon label")
        asof, until = _utc(row.get("as_of"), f"outcomes[{n}].as_of"), _utc(row.get("observed_until"), f"outcomes[{n}].observed_until")
        if not start <= asof or until > end or until < asof + timedelta(hours=horizon):
            raise IntakeError(f"outcomes[{n}] must be observed for the full target horizon inside the dataset window")
        entity = (row["site_id"], row["bin_id"], row["harvest_year"])
        tenant = row["tenant_id"]
        if entity not in split_entity or (tenant, *entity) not in entities:
            raise IntakeError(f"outcomes[{n}] does not join to telemetry and declared split")
        if row["lot_id"] not in lots_by_entity[(tenant, *entity)]:
            raise IntakeError(f"outcomes[{n}] lot_id does not join to telemetry")
        outcome_at = row.get("outcome_at")
        if row["label_value"]:
            outcome_time = _utc(outcome_at, f"outcomes[{n}].outcome_at")
            if not asof <= outcome_time <= asof + timedelta(hours=horizon):
                raise IntakeError(f"outcomes[{n}] positive onset must fall within the target horizon")
        elif outcome_at is not None:
            raise IntakeError(f"outcomes[{n}] negative label must not declare outcome_at")
        if not any(asof <= ts <= until for ts in entities[(tenant, *entity)]):
            raise IntakeError(f"outcomes[{n}] has no telemetry in its observation interval")
        # Only measurements observed AND received by the prediction cutoff can
        # be used as features. Requiring one here prevents a label record from
        # passing intake when all joined telemetry arrives after the forecast.
        if not any(observed <= asof and received <= asof for observed, received in
                   available_readings_by_lot[(tenant, *entity, row["lot_id"])]):
            raise IntakeError(f"outcomes[{n}] has no telemetry available by as_of")
        labelled.add(entity)
    digest = hashlib.sha256(mp.read_bytes() + paths["telemetry"].read_bytes() + paths["outcomes"].read_bytes()).hexdigest()
    return {"status": "contract_valid", "dataset_id": manifest["dataset_id"], "dataset_sha256": digest,
            "telemetry_rows": len(telemetry), "outcome_rows": len(outcomes), "site_bin_entities": len(telemetry_entities),
            "entities_with_outcomes": len(labelled),
            "split_entities": {split: sum(owner == split for owner in split_entity.values()) for split in splits},
            "disclaimer": "Owner provenance declarations are not independently verified; this is not scientific/model validation."}

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path, help="private dataset directory")
    args = parser.parse_args(argv)
    try:
        result = validate_dataset(args.root)
    except (IntakeError, OSError) as exc:
        print(json.dumps({"status": "rejected", "error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
