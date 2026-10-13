"""Build a small synthetic-only Parquet feature dataset from sensor fixtures.

This is an offline I1 prototype. It is intentionally not the complete §3.7
corpus builder: it emits sampled device-level feature rows and does not claim
simulator physics, split validity, sequence windows, or ingest parity.
"""

from __future__ import annotations

import argparse
from bisect import bisect_left, bisect_right
import hashlib
import hmac
import json
import math
import os
import shutil
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from ml_features import TelemetryReading, compute_features

MAX_READING_ROWS = 100_000
MAX_LABEL_ROWS = 100_000
MAX_OUTPUT_ROWS = 25_000
MAX_SEQUENCE_WINDOWS = 25_000
MAX_INPUT_BYTES = 128 * 1024 * 1024
DEFAULT_SAMPLE_MINUTES = 60
DEFAULT_SEQUENCE_STEPS = 96
DEFAULT_SEQUENCE_STRIDE_STEPS = 8
NATIVE_CADENCE = timedelta(minutes=15)
LABEL_NAME = "future_sensor_condition_excursion_48h"
LAYOUT_VERSION = "synthetic-feature-prototype-v2"


class CorpusError(ValueError):
    """Input or policy violation while building an offline corpus."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_jsonl(path: Path, *, max_rows: int) -> list[dict[str, Any]]:
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise CorpusError(f"input exceeds the {MAX_INPUT_BYTES}-byte safety limit: {path}")
    result: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise CorpusError(f"invalid JSON at {path}:{line_number}") from exc
            if not isinstance(value, dict):
                raise CorpusError(f"expected a JSON object at {path}:{line_number}")
            result.append(value)
            if len(result) > max_rows:
                raise CorpusError(f"{path} exceeds the {max_rows}-row safety limit")
    return result


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str):
        raise CorpusError(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise CorpusError(f"{field} is not a valid ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise CorpusError(f"{field} must be UTC")
    return parsed.astimezone(timezone.utc)


def _pseudonym(key: bytes, kind: str, raw_id: str) -> str:
    message = f"{kind}\0{raw_id}".encode("utf-8")
    return hmac.new(key, message, hashlib.sha256).digest()[:16].hex()


def _dependency() -> tuple[Any, Any]:
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise RuntimeError(
            "Parquet output requires the exactly pinned dependency; install with "
            "`python3 -m pip install -r ml/corpus/requirements.txt`"
        ) from exc
    return pa, pq


def _write_partitioned_export(
    pa: Any,
    pq: Any,
    output_dir: Path,
    export_name: str,
    rows: list[dict[str, Any]],
    time_field: str,
) -> dict[str, dict[str, Any]]:
    """Write one parquet part per pseudonymous tenant and UTC month."""
    partitions: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        timestamp = row[time_field]
        partitions[(row["tenant_pk"], timestamp.strftime("%Y-%m"))].append(row)
    files: dict[str, dict[str, Any]] = {}
    for (tenant_pk, month), partition_rows in sorted(partitions.items()):
        relative_path = (
            Path(export_name)
            / f"tenant={tenant_pk}"
            / f"month={month}"
            / "part-00000.parquet"
        )
        path = output_dir / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(pa.Table.from_pylist(partition_rows), path, compression="zstd")
        files[relative_path.as_posix()] = {
            "sha256": _sha256(path),
            "rows": len(partition_rows),
        }
    return files


def _fixture_manifest(readings_path: Path, labels_path: Path) -> dict[str, Any]:
    path = readings_path.parent / "manifest.json"
    if not path.is_file():
        raise CorpusError("expected the sensor fixture manifest beside readings.jsonl")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise CorpusError("sensor fixture manifest is invalid JSON") from exc
    if value.get("synthetic_only") is not True:
        raise CorpusError("corpus builder accepts only a manifest marked synthetic_only=true")
    if value.get("label_not_spoilage") is not True:
        raise CorpusError("fixture must explicitly declare label_not_spoilage=true")
    if value.get("label_name") != LABEL_NAME:
        raise CorpusError(f"unsupported fixture label; expected {LABEL_NAME}")
    if value.get("fixture_version") != 1:
        raise CorpusError("fixture manifest must declare supported fixture_version=1")
    if value.get("scenario") not in {"baseline", "warming"}:
        raise CorpusError("fixture manifest must declare a supported scenario")
    seed = value.get("seed")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise CorpusError("fixture manifest must declare a non-negative integer seed")
    onset_fraction = value.get("onset_fraction")
    if (
        isinstance(onset_fraction, bool)
        or not isinstance(onset_fraction, (int, float))
        or not math.isfinite(onset_fraction)
        or not 0.2 <= onset_fraction <= 0.8
    ):
        raise CorpusError("fixture manifest must declare onset_fraction between 0.2 and 0.8")
    steps = value.get("emitted_days")
    if isinstance(steps, bool) or not isinstance(steps, int) or not 4 <= steps <= 30:
        raise CorpusError("fixture manifest must declare emitted_days between 4 and 30")
    trigger_step = value.get("trigger_step")
    expected_trigger_step = round(steps * 24 * 60 / 15 * onset_fraction)
    if isinstance(trigger_step, bool) or not isinstance(trigger_step, int) or trigger_step != expected_trigger_step:
        raise CorpusError("fixture trigger_step does not match its onset_fraction and duration")
    if value.get("reading_sha256") != _sha256(readings_path):
        raise CorpusError("readings.jsonl checksum does not match the fixture manifest")
    if value.get("label_sha256") != _sha256(labels_path):
        raise CorpusError("labels.jsonl checksum does not match the fixture manifest")
    return value


def build_corpus(
    readings_path: Path,
    labels_path: Path,
    output_dir: Path,
    *,
    sample_minutes: int = DEFAULT_SAMPLE_MINUTES,
    sequence_steps: int = DEFAULT_SEQUENCE_STEPS,
    sequence_stride_steps: int = DEFAULT_SEQUENCE_STRIDE_STEPS,
    hmac_secret: bytes | None = None,
) -> dict[str, Any]:
    """Write pseudonymized feature rows and a synthetic-only manifest.

    The supplied secret is used only to derive a per-dataset key and is never
    persisted. Callers should provide it through ``GG_CORPUS_HMAC_KEY``.
    """
    if sample_minutes < 15 or sample_minutes % 15:
        raise CorpusError("sample_minutes must be a positive multiple of 15")
    if sequence_steps < 8 or sequence_steps % 8:
        raise CorpusError("sequence_steps must be a positive multiple of the 8-step patch")
    if sequence_stride_steps < 8 or sequence_stride_steps % 8:
        raise CorpusError("sequence_stride_steps must be a positive multiple of the 8-step patch")
    secret = hmac_secret if hmac_secret is not None else os.environ.get("GG_CORPUS_HMAC_KEY", "").encode()
    if len(secret) < 32:
        raise CorpusError("GG_CORPUS_HMAC_KEY must contain at least 32 UTF-8 bytes")
    for path in (readings_path, labels_path):
        if not path.is_file():
            raise CorpusError(f"input file does not exist: {path}")
    fixture = _fixture_manifest(readings_path, labels_path)
    fixture_manifest_path = readings_path.parent / "manifest.json"
    fixture_generator_path = Path(__file__).resolve().parents[2] / "tools" / "sensor-fixture" / "generate.py"
    if not fixture_generator_path.is_file():
        raise CorpusError("approved sensor fixture generator is missing from the repository")
    feature_kernel_path = Path(__file__).resolve().parents[2] / "packages" / "ml-features" / "src" / "ml_features" / "kernel.py"
    if not feature_kernel_path.is_file():
        raise CorpusError("shared feature kernel is missing from the repository")
    if output_dir.exists():
        if not output_dir.is_dir() or any(output_dir.iterdir()):
            raise CorpusError("output directory must be absent or empty")
    reading_rows = _read_jsonl(readings_path, max_rows=MAX_READING_ROWS)
    labels = _read_jsonl(labels_path, max_rows=MAX_LABEL_ROWS)
    if not reading_rows or not labels:
        raise CorpusError("fixture readings and labels must both be non-empty")

    input_hashes = {
        "readings.jsonl": _sha256(readings_path),
        "labels.jsonl": _sha256(labels_path),
    }
    fixture_manifest_hash = _sha256(fixture_manifest_path)
    generator_hash = _sha256(fixture_generator_path)
    builder_hash = _sha256(Path(__file__).resolve())
    feature_kernel_hash = _sha256(feature_kernel_path)
    dataset_identity = {
        "layout_version": LAYOUT_VERSION,
        "fixture_manifest_sha256": fixture_manifest_hash,
        "input_sha256": input_hashes,
        "fixture_generator_sha256": generator_hash,
        "corpus_builder_sha256": builder_hash,
        "feature_kernel_sha256": feature_kernel_hash,
        "sample_minutes": sample_minutes,
        "sequence_steps": sequence_steps,
        "sequence_stride_steps": sequence_stride_steps,
    }
    identity_bytes = json.dumps(
        dataset_identity, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()
    dataset_id = hmac.new(
        secret,
        b"greenguard-corpus-dataset-id-v1\0" + identity_bytes,
        hashlib.sha256,
    ).hexdigest()[:32]
    dataset_key = hmac.new(
        secret,
        f"greenguard-corpus-pseudonym-key-v1\0{dataset_id}".encode(),
        hashlib.sha256,
    ).digest()

    by_device: dict[tuple[str, str], list[TelemetryReading]] = defaultdict(list)
    raw_context: dict[tuple[str, str], dict[str, str]] = {}
    seen_event_ids: set[str] = set()
    for row in reading_rows:
        if row.get("event_type") != "telemetry.recorded" or row.get("schema_version") != 1:
            raise CorpusError("only telemetry.recorded schema_version=1 fixture rows are accepted")
        tenant = row.get("tenant_id")
        payload = row.get("payload")
        if not isinstance(tenant, str) or not isinstance(payload, dict):
            raise CorpusError("reading is missing tenant_id or payload")
        device = payload.get("device_id")
        site = payload.get("site_id")
        bin_id = payload.get("bin_id")
        measurements = payload.get("measurements")
        if not all(isinstance(value, str) and value for value in (device, site, bin_id)):
            raise CorpusError("reading must contain device_id, site_id, and bin_id")
        if not isinstance(measurements, dict):
            raise CorpusError("reading payload.measurements must be an object")
        for metric in ("temperature_c", "relative_humidity_percent"):
            value = measurements.get(metric)
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
                raise CorpusError(f"measurement {metric} must be a number or null")
            if isinstance(value, float) and not math.isfinite(value):
                raise CorpusError(f"measurement {metric} must be finite")
        event_id = row.get("event_id")
        if not isinstance(event_id, str) or not event_id:
            raise CorpusError("reading must contain a non-empty event_id")
        if event_id in seen_event_ids:
            raise CorpusError("fixture contains a duplicate event_id")
        seen_event_ids.add(event_id)
        key = (tenant, device)
        context = {"tenant": tenant, "site": site, "bin": bin_id, "device": device}
        previous = raw_context.setdefault(key, context)
        if previous != context:
            raise CorpusError("device identity changed tenant/site/bin within fixture")
        by_device[key].append(
            TelemetryReading(
                tenant_id=tenant,
                device_id=device,
                event_id=event_id,
                observed_at=_timestamp(payload.get("observed_at"), "payload.observed_at"),
                received_at=_timestamp(payload.get("received_at"), "payload.received_at"),
                measurements={
                    "temperature_c": measurements.get("temperature_c"),
                    "relative_humidity_percent": measurements.get("relative_humidity_percent"),
                },
            )
        )
    for rows in by_device.values():
        rows.sort(key=lambda reading: (reading.observed_at, reading.received_at, reading.event_id))

    labels_by_bin_as_of: dict[tuple[str, str, str, datetime], dict[str, Any]] = {}
    label_export_rows: list[dict[str, Any]] = []
    known_bins = {
        (context["tenant"], context["site"], context["bin"])
        for context in raw_context.values()
    }
    for label in labels:
        if label.get("label_name") != LABEL_NAME or label.get("label_not_spoilage") is not True:
            raise CorpusError("every label must be the declared non-spoilage sensor-condition label")
        if not str(label.get("label_origin", "")).startswith("synthetic_signal_fixture"):
            raise CorpusError("refusing label with non-synthetic origin")
        if not isinstance(label.get("label_value"), bool):
            raise CorpusError("label_value must be boolean")
        identity = (label.get("tenant_id"), label.get("site_id"), label.get("bin_id"))
        if not all(isinstance(value, str) and value.strip() for value in identity):
            raise CorpusError("label must contain non-empty string tenant_id, site_id, and bin_id")
        if identity not in known_bins:
            raise CorpusError("label identity does not match a tenant/site/bin in fixture readings")
        label_key = (
            identity[0],
            identity[1],
            identity[2],
            _timestamp(label.get("as_of"), "label.as_of"),
        )
        if label_key in labels_by_bin_as_of:
            raise CorpusError("duplicate label for tenant/site/bin/as_of")
        labels_by_bin_as_of[label_key] = label
        tenant, site, bin_id, as_of = label_key
        label_export_rows.append({
            "tenant_pk": _pseudonym(dataset_key, "tenant", tenant),
            "site_pk": _pseudonym(dataset_key, "site", site),
            "bin_pk": _pseudonym(dataset_key, "bin", bin_id),
            "label": LABEL_NAME,
            "as_of": as_of,
            "value": label["label_value"],
            "origin": "synthetic_signal_fixture_not_spoilage",
            "label_not_spoilage": True,
            "thresholds": label.get("thresholds", {}),
            "data_origin": "synthetic",
            "split": "unsplit_synthetic_fixture",
        })

    pa, pq = _dependency()
    output_rows: list[dict[str, Any]] = []
    sequence_rows: list[dict[str, Any]] = []
    step = timedelta(minutes=sample_minutes)
    for stream_key, stream in sorted(by_device.items()):
        context = raw_context[stream_key]
        observed_times = [reading.observed_at for reading in stream]
        reading_by_observed: dict[datetime, TelemetryReading] = {}
        for reading in stream:
            if reading.observed_at in reading_by_observed:
                raise CorpusError("device stream contains duplicate observed_at timestamps")
            if (reading.observed_at - stream[0].observed_at) % NATIVE_CADENCE:
                raise CorpusError("device stream contains a reading off the 15-minute cadence")
            reading_by_observed[reading.observed_at] = reading
        as_of = stream[0].observed_at
        last_observed = stream[-1].observed_at
        while as_of <= last_observed:
            window_start = as_of - timedelta(hours=24)
            window_index = bisect_left(observed_times, window_start)
            end_index = bisect_right(observed_times, as_of)
            candidates = stream[window_index:end_index]
            # Preserve the latest as-seen value for stale/latest features
            # without rescanning and passing the entire history each time.
            for prior_index in range(window_index - 1, -1, -1):
                reading = stream[prior_index]
                if reading.received_at <= as_of:
                    candidates.append(reading)
                    break
            if not candidates:
                # The first observed event can arrive after its event time.
                # Keep an identity anchor; the kernel excludes it as future.
                candidates.append(stream[0])
            vector = compute_features(candidates, as_of=as_of)
            row: dict[str, Any] = {
                "tenant_pk": _pseudonym(dataset_key, "tenant", context["tenant"]),
                "site_pk": _pseudonym(dataset_key, "site", context["site"]),
                "bin_pk": _pseudonym(dataset_key, "bin", context["bin"]),
                "device_pk": _pseudonym(dataset_key, "device", context["device"]),
                "as_of": as_of,
                "feature_set_version": vector.key.feature_set_version,
                "revision": vector.key.revision,
                "data_origin": "synthetic",
                "split": "unsplit_synthetic_fixture",
            }
            for name, value in vector.values.items():
                row[name] = value
            output_rows.append(row)
            if len(output_rows) > MAX_OUTPUT_ROWS:
                raise CorpusError(f"sample would exceed {MAX_OUTPUT_ROWS} output rows; increase sample_minutes")
            as_of += step

        tenant_pk = _pseudonym(dataset_key, "tenant", context["tenant"])
        site_pk = _pseudonym(dataset_key, "site", context["site"])
        bin_pk = _pseudonym(dataset_key, "bin", context["bin"])
        device_pk = _pseudonym(dataset_key, "device", context["device"])
        cadence_slots = int((stream[-1].observed_at - stream[0].observed_at) / NATIVE_CADENCE) + 1
        for start_index in range(
            sequence_steps,
            cadence_slots + 1,
            sequence_stride_steps,
        ):
            expected_times = [
                stream[0].observed_at + index * NATIVE_CADENCE
                for index in range(start_index - sequence_steps, start_index)
            ]
            prediction_as_of = stream[0].observed_at + start_index * NATIVE_CADENCE
            observed_at: list[datetime | None] = []
            received_at: list[datetime | None] = []
            temperatures: list[float | None] = []
            humidities: list[float | None] = []
            missing_mask: list[bool] = []
            backfilled: list[bool] = []
            for expected_time in expected_times:
                reading = reading_by_observed.get(expected_time)
                if reading is None or reading.received_at > prediction_as_of:
                    observed_at.append(None)
                    received_at.append(None)
                    temperatures.append(None)
                    humidities.append(None)
                    missing_mask.append(True)
                    backfilled.append(False)
                    continue
                temperature = reading.measurements.get("temperature_c")
                humidity = reading.measurements.get("relative_humidity_percent")
                observed_at.append(reading.observed_at)
                received_at.append(reading.received_at)
                temperatures.append(float(temperature) if temperature is not None else None)
                humidities.append(float(humidity) if humidity is not None else None)
                missing_mask.append(temperature is None or humidity is None)
                backfilled.append(False)

            start_time = expected_times[0]
            window_id = _pseudonym(
                dataset_key,
                "window",
                f"{context['tenant']}\0{context['bin']}\0{context['device']}\0{start_time.isoformat()}",
            )
            sequence_rows.append({
                "tenant_pk": tenant_pk,
                "bin_pk": bin_pk,
                "device_pk": device_pk,
                "window_start": start_time,
                "window_end": expected_times[-1],
                "prediction_as_of": prediction_as_of,
                "window_id": window_id,
                "context_steps": sequence_steps,
                "cadence_minutes": 15,
                "observed_at": observed_at,
                "received_at": received_at,
                "temperature_c": temperatures,
                "relative_humidity_percent": humidities,
                "missing_mask": missing_mask,
                "backfilled": backfilled,
                "data_origin": "synthetic",
                "split": "unsplit_synthetic_fixture",
            })
            if len(sequence_rows) > MAX_SEQUENCE_WINDOWS:
                raise CorpusError(
                    f"sequence export exceeds {MAX_SEQUENCE_WINDOWS} windows; increase sequence_stride_steps"
                )

    if not output_rows or not sequence_rows or not label_export_rows:
        raise CorpusError("fixture must produce feature rows, sequence windows, and labels")

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging_dir = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.tmp-", dir=output_dir.parent))
    try:
        parquet_path = staging_dir / "training_rows.parquet"
        table = pa.Table.from_pylist(output_rows)
        pq.write_table(table, parquet_path, compression="zstd")
        files = {
            "training_rows.parquet": {"sha256": _sha256(parquet_path), "rows": len(output_rows)}
        }
        files.update(_write_partitioned_export(
            pa, pq, staging_dir, "sequence_windows", sequence_rows, "window_start"
        ))
        files.update(_write_partitioned_export(
            pa, pq, staging_dir, "labels", label_export_rows, "as_of"
        ))
        manifest: dict[str, Any] = {
            "status": "offline synthetic-only corpus prototype; not an accepted training dataset",
            "synthetic_only": True,
            "data_origin": "synthetic",
            "label_name": LABEL_NAME,
            "label_not_spoilage": True,
            "label_semantics": "fixture-defined future temperature and air-RH threshold excursion; not spoilage, damage, or agronomic risk",
            "layout_version": LAYOUT_VERSION,
            "dataset_id": dataset_id,
            "feature_set_version": output_rows[0]["feature_set_version"],
            "label_spec_version": 1,
            "fixture_version": fixture["fixture_version"],
            "fixture_days": fixture["emitted_days"],
            "onset_fraction": fixture["onset_fraction"],
            "trigger_step": fixture["trigger_step"],
            "scenario": fixture["scenario"],
            "seed": fixture["seed"],
            "fixture_manifest_sha256": fixture_manifest_hash,
            "fixture_generator_sha256": generator_hash,
            "corpus_builder_sha256": builder_hash,
            "feature_kernel_sha256": feature_kernel_hash,
            "sample_minutes": sample_minutes,
            "sequence_steps": sequence_steps,
            "sequence_stride_steps": sequence_stride_steps,
            "sequence_cadence_minutes": 15,
            "view": "as_seen",
            "split": "unsplit_synthetic_fixture",
            "row_grain": "device-level feature vector sampled every sample_minutes from each device's first observation; not joined to label timestamps",
            "input_sha256": input_hashes,
            "rows": len(output_rows),
            "distinct_tenant_pseudonyms": len({row["tenant_pk"] for row in output_rows}),
            "distinct_site_pseudonyms": len({row["site_pk"] for row in output_rows}),
            "distinct_bin_pseudonyms": len({row["bin_pk"] for row in output_rows}),
            "distinct_device_pseudonyms": len({row["device_pk"] for row in output_rows}),
            "sequence_windows": len(sequence_rows),
            "labels": len(label_export_rows),
            "files": files,
            "limitations": [
                "synthetic signal fixture, not a grain-physics simulator",
                "one synthetic tenant/site/bin does not support site/time/weather-year generalization splits",
                "feature rows remain sampled device-level prototype rows, not §3.7 bin_features",
                "labels are point-in-time synthetic threshold-excursion booleans, not spoilage intervals",
                "sequence windows have no mount, lot, ambient, or backfill metadata in the source fixture",
                "partitioned exports are a limited prototype and do not establish the complete §3.7 layout",
                "does not establish simulator/real-ingest feature parity or §3.7 contract acceptance",
            ],
        }
        canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        manifest["dataset_hash"] = hashlib.sha256(canonical).hexdigest()
        (staging_dir / "manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        if output_dir.exists():
            output_dir.rmdir()
        os.replace(staging_dir, output_dir)
        return manifest
    finally:
        if staging_dir.exists():
            shutil.rmtree(staging_dir)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--readings", type=Path, required=True, help="fixture readings.jsonl")
    parser.add_argument("--labels", type=Path, required=True, help="fixture labels.jsonl")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sample-minutes", type=int, default=DEFAULT_SAMPLE_MINUTES)
    parser.add_argument("--sequence-steps", type=int, default=DEFAULT_SEQUENCE_STEPS)
    parser.add_argument(
        "--sequence-stride-steps",
        type=int,
        default=DEFAULT_SEQUENCE_STRIDE_STEPS,
    )
    args = parser.parse_args(argv)
    try:
        manifest = build_corpus(
            args.readings,
            args.labels,
            args.output,
            sample_minutes=args.sample_minutes,
            sequence_steps=args.sequence_steps,
            sequence_stride_steps=args.sequence_stride_steps,
        )
    except (CorpusError, RuntimeError) as exc:
        print(f"corpus build failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({key: value for key, value in manifest.items() if key != "files"}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
