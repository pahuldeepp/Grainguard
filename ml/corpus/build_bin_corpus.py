"""Build a bounded bin-level feature and label corpus from grain-sim runs."""

from __future__ import annotations

import argparse
from collections import defaultdict
from bisect import bisect_right
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import tempfile
from typing import Any

from ml_features import TelemetryReading, compute_features

MAX_INPUT_BYTES = 256 * 1024 * 1024
MAX_ROWS = 250_000
SAMPLE_STEP = timedelta(hours=1)
MIN_WINDOW = timedelta(hours=24)
SEQUENCE_STEPS = 96
SEQUENCE_STRIDE_STEPS = 8
FEATURES = (
    "reading_count_1h", "reading_count_24h", "latest_reading_age_minutes",
    "temperature_c", "temperature_c_missing", "relative_humidity_percent",
    "relative_humidity_percent_missing", "temperature_c_mean_1h",
    "temperature_c_mean_24h", "temperature_c_delta_1h", "temperature_c_delta_24h",
    "relative_humidity_percent_mean_1h", "relative_humidity_percent_mean_24h",
    "relative_humidity_percent_delta_1h", "relative_humidity_percent_delta_24h",
    "max_gap_minutes_24h", "coverage_24h", "lateness_minutes_mean_24h",
)


class CorpusError(ValueError):
    pass


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read(path: Path, max_rows: int = MAX_ROWS) -> list[dict[str, Any]]:
    if not path.is_file() or path.stat().st_size > MAX_INPUT_BYTES:
        raise CorpusError(f"missing or oversized input: {path}")
    rows = []
    for index, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise CorpusError(f"invalid JSON at {path}:{index}") from exc
        if not isinstance(value, dict):
            raise CorpusError(f"expected object at {path}:{index}")
        rows.append(value)
        if len(rows) > max_rows:
            raise CorpusError(f"{path} exceeds {max_rows} rows")
    return rows


def _time(raw: object, name: str) -> datetime:
    if not isinstance(raw, str):
        raise CorpusError(f"{name} must be an ISO UTC timestamp")
    try:
        result = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise CorpusError(f"invalid timestamp in {name}") from exc
    if result.tzinfo is None or result.utcoffset() != timedelta(0):
        raise CorpusError(f"{name} must be UTC")
    return result.astimezone(timezone.utc)


def _pseudonym(key: bytes, kind: str, raw: str) -> str:
    return hmac.new(key, f"{kind}\0{raw}".encode(), hashlib.sha256).digest()[:16].hex()


def _parquet() -> tuple[Any, Any]:
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise RuntimeError("install pinned dependencies from ml/corpus/requirements.txt") from exc
    return pa, pq


def build_bin_corpus(input_dir: Path, output_dir: Path, secret: bytes | None = None,
                     sequence_stride_steps: int = SEQUENCE_STRIDE_STEPS) -> dict[str, Any]:
    key_material = secret if secret is not None else os.environ.get("GG_CORPUS_HMAC_KEY", "").encode()
    if len(key_material) < 32:
        raise CorpusError("GG_CORPUS_HMAC_KEY must contain at least 32 bytes")
    if isinstance(sequence_stride_steps, bool) or not isinstance(sequence_stride_steps, int) or not 1 <= sequence_stride_steps <= 96:
        raise CorpusError("sequence_stride_steps must be an integer from 1 to 96")
    if output_dir.exists() and (not output_dir.is_dir() or any(output_dir.iterdir())):
        raise CorpusError("output directory must be absent or empty")
    input_manifest = input_dir / "manifest.json"
    try:
        sim_manifest = json.loads(input_manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CorpusError("simulator manifest missing or invalid") from exc
    if sim_manifest.get("synthetic_only") is not True or sim_manifest.get("label_not_spoilage") is not True:
        raise CorpusError("only explicitly synthetic non-spoilage simulator input is accepted")
    if sim_manifest.get("simulator_version") not in {"grain-column-exp-0.1.0", "grain-column-exp-0.1.1"}:
        raise CorpusError("unsupported simulator version")
    paths = {name: input_dir / name for name in ("readings.jsonl", "labels.jsonl", "mounts.jsonl", "ambient.jsonl", "lot_context.json")}
    for name, path in paths.items():
        if sim_manifest.get("files", {}).get(name) != _sha(path):
            raise CorpusError(f"simulator checksum mismatch: {name}")
    readings_raw, labels_raw, mounts_raw, ambient_raw = (_read(paths[name]) for name in paths if name != "lot_context.json")
    try:
        lot_raw = json.loads(paths["lot_context.json"].read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CorpusError("lot context is missing or invalid") from exc
    if not readings_raw or not labels_raw or len(mounts_raw) != 16:
        raise CorpusError("expected readings, labels, and all 16 reference-bin mounts")
    if not isinstance(lot_raw, dict) or lot_raw.get("synthetic_only") is not True or lot_raw.get("data_origin") != "synthetic_grain_sim":
        raise CorpusError("lot context must be explicitly synthetic simulator input")
    if not ambient_raw or any(row.get("synthetic_only") is not True for row in ambient_raw):
        raise CorpusError("ambient context must contain explicitly synthetic simulator samples")

    tenant_ids = {row.get("tenant_id") for row in readings_raw}
    bin_ids = {row.get("payload", {}).get("bin_id") for row in readings_raw if isinstance(row.get("payload"), dict)}
    if len(tenant_ids) != 1 or len(bin_ids) != 1:
        raise CorpusError("one simulator run must contain exactly one tenant and bin")
    tenant_id, bin_id = next(iter(tenant_ids)), next(iter(bin_ids))
    if not isinstance(tenant_id, str) or not isinstance(bin_id, str):
        raise CorpusError("simulator tenant/bin IDs are invalid")
    site_ids = {row.get("payload", {}).get("site_id") for row in readings_raw if isinstance(row.get("payload"), dict)}
    if len(site_ids) != 1:
        raise CorpusError("one simulator run must contain exactly one site")
    site_id = next(iter(site_ids))
    if not all(lot_raw.get(name) == expected for name, expected in (("tenant_id", tenant_id), ("site_id", site_id), ("bin_id", bin_id))):
        raise CorpusError("lot context identity does not match the reading run")
    if any(row.get("tenant_id") != tenant_id or row.get("site_id") != site_id or row.get("bin_id") != bin_id for row in mounts_raw):
        raise CorpusError("mount context identity does not match the reading run")
    if any(row.get("site_id") != site_id or row.get("bin_id") != bin_id for row in ambient_raw):
        raise CorpusError("ambient context identity does not match the reading run")

    source_hashes = {
        "simulator": _sha(Path(__file__).resolve().parents[2] / "tools" / "grain-sim" / "simulate.py"),
        "corpus_builder": _sha(Path(__file__).resolve()),
        "feature_kernel": _sha(Path(__file__).resolve().parents[2] / "packages" / "ml-features" / "src" / "ml_features" / "kernel.py"),
    }
    identity = {
        "layout_version": "telemetry-v1.0-bin-v2-sequence96",
        "sequence_length": SEQUENCE_STEPS,
        "sequence_stride_steps": sequence_stride_steps,
        "simulator_manifest_sha256": _sha(input_manifest),
        "input_sha256": {name: _sha(path) for name, path in sorted(paths.items())},
        "source_sha256": source_hashes,
    }
    identity_bytes = json.dumps(identity, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    dataset_id = hmac.new(key_material, b"grain-sim-bin-corpus-v2\0" + identity_bytes, hashlib.sha256).hexdigest()[:32]
    dataset_key = hmac.new(key_material, f"grain-sim-key-v1\0{dataset_id}".encode(), hashlib.sha256).digest()
    tenant_pk, bin_pk = _pseudonym(dataset_key, "tenant", tenant_id), _pseudonym(dataset_key, "bin", bin_id)
    run_id = str(sim_manifest["run_id"])
    run_pk = _pseudonym(dataset_key, "run", run_id)

    by_device: dict[str, list[TelemetryReading]] = defaultdict(list)
    observed_keys: set[tuple[str, datetime]] = set()
    for row in readings_raw:
        payload = row.get("payload")
        if not isinstance(payload, dict):
            raise CorpusError("reading is missing payload")
        if row.get("event_type") != "telemetry.recorded" or row.get("schema_version") != 1:
            raise CorpusError("reading is not canonical telemetry.recorded v1")
        device_id = payload.get("device_id")
        measurements = payload.get("measurements")
        if not isinstance(device_id, str) or not isinstance(measurements, dict):
            raise CorpusError("reading has invalid device or measurements")
        observed_at = _time(payload.get("observed_at"), "observed_at")
        if (device_id, observed_at) in observed_keys:
            raise CorpusError("duplicate device observation timestamp")
        observed_keys.add((device_id, observed_at))
        by_device[device_id].append(TelemetryReading(
            tenant_id=tenant_id, device_id=device_id, event_id=str(row.get("event_id")),
            observed_at=observed_at,
            received_at=_time(payload.get("received_at"), "received_at"),
            measurements=measurements,
        ))
    if len(by_device) != 16:
        raise CorpusError("expected exactly 16 devices in the reference bin")

    mounts = {row["device_id"]: row for row in mounts_raw}
    if set(mounts) != set(by_device):
        raise CorpusError("mount metadata must match the exact device set")
    label_map: dict[datetime, bool] = {}
    for row in labels_raw:
        if row.get("label_name") != "simulated_hotspot_onset_48h" or row.get("synthetic_only") is not True or row.get("label_not_spoilage") is not True:
            raise CorpusError("unsupported/non-synthetic simulator label")
        at = _time(row.get("as_of"), "label.as_of")
        if at in label_map or not isinstance(row.get("label_value"), bool):
            raise CorpusError("duplicate or malformed simulator label")
        label_map[at] = row["label_value"]

    if set(label_map) != {_time(row.get("as_of"), "ambient.as_of") for row in ambient_raw}:
        raise CorpusError("ambient context timestamps must match the exact label time grid")
    ambient_map = {_time(row["as_of"], "ambient.as_of"): row for row in ambient_raw}

    sample_times = sorted(label_map)
    earliest = min(row.observed_at for values in by_device.values() for row in values)
    feature_rows: list[dict[str, Any]] = []
    labels: list[dict[str, Any]] = []
    sequence_rows: list[dict[str, Any]] = []
    samples = sorted(label_map)
    sequence_index_by_time = {at: index for index, at in enumerate(samples)}
    observed_times_by_device = {
        device_id: [row.observed_at for row in values]
        for device_id, values in by_device.items()
    }
    observed_by_device = {
        device_id: {row.observed_at: row for row in values}
        for device_id, values in by_device.items()
    }
    for as_of in sample_times:
        if as_of - earliest < MIN_WINDOW:
            continue
        vectors = []
        latest_by_device: list[tuple[int, int, float]] = []
        for device_id, values in by_device.items():
            observed_times = observed_times_by_device[device_id]
            window_start = as_of - timedelta(hours=24)
            window_left = bisect_right(observed_times, window_start)
            window_right = bisect_right(observed_times, as_of)
            candidates = [
                row for row in values[window_left:window_right]
                if row.received_at <= as_of
            ]
            prior = next((
                values[index] for index in range(window_left - 1, -1, -1)
                if values[index].received_at <= as_of
            ), None)
            if prior is not None:
                candidates.insert(0, prior)
            if not candidates:
                # The kernel requires one identity anchor even when every row
                # is future-delivered. It excludes this row by its timestamps.
                candidates.append(values[0])
            vector = compute_features(candidates, as_of=as_of)
            vectors.append(vector.values)
            latest = None
            latest_end = bisect_right(observed_times_by_device[device_id], as_of)
            for index in range(latest_end - 1, -1, -1):
                if values[index].received_at <= as_of:
                    latest = values[index]
                    break
            if latest is not None:
                mount = mounts[device_id]
                latest_by_device.append((int(mount["node_index"]), int(mount["cable_label"][1:]), float(latest.measurements["temperature_c"])))
            # Every sequence row is a fixed 96-step point-in-time window. The
            # upper bound is strict: samples observed at `as_of` are excluded
            # when received after `as_of` (as this simulator's +2s delivery is).
            as_index = sequence_index_by_time[as_of]
            if as_index >= SEQUENCE_STEPS and as_index % sequence_stride_steps == 0:
                window_times = samples[as_index - SEQUENCE_STEPS:as_index]
                observed_by_time = observed_by_device[device_id]
                selected = [
                    reading if reading is not None and reading.received_at <= as_of else None
                    for sample_at in window_times
                    for reading in (observed_by_time.get(sample_at),)
                ]
                sequence_rows.append({
                    "dataset_id": dataset_id, "tenant_pk": tenant_pk,
                    "site_pk": _pseudonym(dataset_key, "site", str(lot_raw.get("site_id", ""))),
                    "bin_pk": bin_pk, "device_pk": _pseudonym(dataset_key, "device", device_id),
                    "run_pk": run_pk, "as_of": as_of,
                    "step_timestamps": window_times,
                    "temperature_c": [item.measurements.get("temperature_c") if item else None for item in selected],
                    "relative_humidity_percent": [item.measurements.get("relative_humidity_percent") if item else None for item in selected],
                    "missing_mask": [item is None for item in selected],
                    "data_origin": "synthetic_grain_sim", "synthetic_only": True,
                    "sequence_length": SEQUENCE_STEPS,
                })
        record: dict[str, Any] = {
            "dataset_id": dataset_id, "tenant_pk": tenant_pk, "bin_pk": bin_pk,
            "run_pk": run_pk, "as_of": as_of, "feature_set_version": "telemetry-v1.0-bin-v1",
            "data_origin": "synthetic_grain_sim", "split": "unsplit_synthetic_run",
            "label_not_spoilage": True,
        }
        for name in FEATURES:
            available = [vector[name] for vector in vectors if isinstance(vector[name], (int, float)) and not isinstance(vector[name], bool)]
            record[name] = sum(available) / len(available) if available else None
        temperatures = [item[2] for item in latest_by_device]
        shallow = [value for depth, _, value in latest_by_device if depth == 1]
        deep = [value for depth, _, value in latest_by_device if depth == 4]
        central = [value for _, cable, value in latest_by_device if cable in {1, 2}]
        outer = [value for _, cable, value in latest_by_device if cable in {3, 4}]
        record.update({
            "sensor_count": len(temperatures),
            "temperature_c_spread_latest": max(temperatures) - min(temperatures) if temperatures else None,
            "temperature_c_deep_minus_shallow": (sum(deep) / len(deep) - sum(shallow) / len(shallow)) if deep and shallow else None,
            "temperature_c_central_minus_outer": (sum(central) / len(central) - sum(outer) / len(outer)) if central and outer else None,
        })
        feature_rows.append(record)
        labels.append({
            "dataset_id": dataset_id, "tenant_pk": tenant_pk, "bin_pk": bin_pk,
            "run_pk": run_pk, "as_of": as_of, "label": "simulated_hotspot_onset_48h",
            "value": label_map[as_of], "data_origin": "synthetic_grain_sim",
            "label_not_spoilage": True, "split": "unsplit_synthetic_run",
        })
    if not feature_rows or len(feature_rows) != len(labels):
        raise CorpusError("no exact bin/time feature-label rows remain after the full history window")

    pa, pq = _parquet()
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{output_dir.name}.staging-", dir=output_dir.parent) as temporary:
        temp_root = Path(temporary)
        pq.write_table(pa.Table.from_pylist(feature_rows), temp_root / "bin_features.parquet", compression="zstd")
        pq.write_table(pa.Table.from_pylist(labels), temp_root / "labels.parquet", compression="zstd")
        pq.write_table(pa.Table.from_pylist(sequence_rows), temp_root / "sequence_windows.parquet", compression="zstd")
        mount_rows = [{
            "device_pk": _pseudonym(dataset_key, "device", row["device_id"]),
            "tenant_pk": tenant_pk, "site_pk": _pseudonym(dataset_key, "site", row["site_id"]),
            "bin_pk": bin_pk, "cable_label": row["cable_label"], "node_index": row["node_index"],
            "depth_m": row["depth_m"], "radial_m": row["radial_m"], "role": row["role"],
            "mount_version": row["mount_version"], "data_origin": "synthetic_grain_sim", "synthetic_only": True,
        } for row in mounts_raw]
        ambient_rows = [{
            "tenant_pk": tenant_pk, "site_pk": _pseudonym(dataset_key, "site", row["site_id"]),
            "bin_pk": bin_pk, "as_of": _time(row["as_of"], "ambient.as_of"),
            "ambient_temperature_c": row["ambient_temperature_c"],
            "ambient_relative_humidity_percent": row["ambient_relative_humidity_percent"],
            "data_origin": "synthetic_grain_sim", "synthetic_only": True,
        } for row in ambient_raw]
        lot_export = {
            "tenant_pk": tenant_pk,
            "site_pk": _pseudonym(dataset_key, "site", str(lot_raw.get("site_id", ""))),
            "bin_pk": bin_pk, "lot_pk": _pseudonym(dataset_key, "lot", str(lot_raw.get("lot_id", ""))),
            "crop": lot_raw.get("crop"), "crop_basis": lot_raw.get("crop_basis"),
            "scenario": lot_raw.get("scenario"),
            "initial_moisture_wet_basis_percent": lot_raw.get("initial_moisture_wet_basis_percent"),
            "data_origin": "synthetic_grain_sim", "synthetic_only": True,
            "limitations": lot_raw.get("limitations", []),
        }
        pq.write_table(pa.Table.from_pylist(mount_rows), temp_root / "mount_context.parquet", compression="zstd")
        pq.write_table(pa.Table.from_pylist(ambient_rows), temp_root / "ambient_context.parquet", compression="zstd")
        (temp_root / "lot_context.json").write_text(json.dumps(lot_export, indent=2, sort_keys=True) + "\n")
        file_names = ("bin_features.parquet", "labels.parquet", "sequence_windows.parquet", "mount_context.parquet", "ambient_context.parquet", "lot_context.json")
        file_hashes = {name: {"sha256": _sha(temp_root / name)} for name in file_names}
        file_hashes["bin_features.parquet"]["rows"] = len(feature_rows)
        file_hashes["labels.parquet"]["rows"] = len(labels)
        file_hashes["sequence_windows.parquet"]["rows"] = len(sequence_rows)
        file_hashes["mount_context.parquet"]["rows"] = len(mount_rows)
        file_hashes["ambient_context.parquet"]["rows"] = len(ambient_rows)
        (temp_root / "manifest.json").write_text(json.dumps({
            "dataset_id": dataset_id, "run_pk": run_pk, "simulator_version": sim_manifest["simulator_version"],
            "scenario": sim_manifest["scenario"], "seed": sim_manifest["seed"],
            "feature_set_version": "telemetry-v1.0-bin-v2-sequence96", "data_origin": "synthetic_grain_sim",
            "synthetic_only": True, "label_name": "simulated_hotspot_onset_48h",
            "label_not_spoilage": True, "split": "unsplit_synthetic_run",
            "rows": len(feature_rows), "positive_rate": sum(label_map[row["as_of"]] for row in labels) / len(labels),
            "source_manifest_sha256": _sha(input_manifest),
            "source_sha256": source_hashes,
            "sequence_length": SEQUENCE_STEPS, "sequence_stride_steps": sequence_stride_steps,
            "sequence_rows": len(sequence_rows), "files": file_hashes,
            "context_origin": "declared synthetic simulator state only",
            "limitations": sim_manifest["limitations"],
        }, indent=2, sort_keys=True) + "\n")
        if output_dir.exists():
            if not output_dir.is_dir() or any(output_dir.iterdir()):
                raise CorpusError("output directory became nonempty during export")
            output_dir.rmdir()
        temp_root.rename(output_dir)
    return json.loads((output_dir / "manifest.json").read_text())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--sequence-stride-steps", type=int, default=SEQUENCE_STRIDE_STEPS)
    args = parser.parse_args()
    print(json.dumps(build_bin_corpus(args.input_dir, args.output_dir, sequence_stride_steps=args.sequence_stride_steps), indent=2))


if __name__ == "__main__":
    main()
