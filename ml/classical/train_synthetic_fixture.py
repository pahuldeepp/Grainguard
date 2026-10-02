"""Fit a tiny, offline logistic baseline to the authorized synthetic fixture.

This estimates the fixture's future synthetic sensor-threshold excursion only.
It is not a spoilage, damage, or agronomic-risk model and cannot be deployed.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import sys
import tempfile
from typing import Any, Sequence

LABEL_NAME = "future_sensor_condition_excursion_48h"
LABEL_HORIZON = timedelta(hours=48)
FEATURE_CONTEXT = timedelta(hours=24)
PURGE_HORIZON = FEATURE_CONTEXT + LABEL_HORIZON
FEATURES = (
    "temperature_c_mean_1h",
    "temperature_c_mean_24h",
    "temperature_c_delta_1h",
    "temperature_c_delta_24h",
    "relative_humidity_percent_mean_1h",
    "relative_humidity_percent_mean_24h",
    "relative_humidity_percent_delta_1h",
    "relative_humidity_percent_delta_24h",
    "coverage_24h",
)


class TrainingError(ValueError):
    """The input dataset is not eligible for this synthetic-only fit."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise TrainingError(f"{field} must be a timezone-aware Parquet timestamp")
    return value.astimezone(timezone.utc)


def _load_dataset(dataset_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise RuntimeError(
            "Parquet input requires the pinned dependency; install with "
            "`python3 -m pip install -r ml/corpus/requirements.txt`"
        ) from exc

    manifest_path = dataset_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TrainingError("dataset manifest is missing or invalid JSON") from exc
    if (
        manifest.get("synthetic_only") is not True
        or manifest.get("data_origin") != "synthetic"
        or manifest.get("label_name") != LABEL_NAME
        or manifest.get("label_not_spoilage") is not True
        or manifest.get("split") != "unsplit_synthetic_fixture"
    ):
        raise TrainingError("only the authorized synthetic threshold-excursion corpus is accepted")

    claimed_hash = manifest.get("dataset_hash")
    unhashed_manifest = dict(manifest)
    unhashed_manifest.pop("dataset_hash", None)
    computed_hash = hashlib.sha256(
        json.dumps(unhashed_manifest, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()
    if not isinstance(claimed_hash, str) or claimed_hash != computed_hash:
        raise TrainingError("dataset manifest hash is invalid")

    files = manifest.get("files")
    if not isinstance(files, dict) or "training_rows.parquet" not in files:
        raise TrainingError("dataset manifest has no training_rows.parquet entry")
    root = dataset_dir.resolve()

    def verified_path(relative: str, details: Any) -> Path:
        if not isinstance(relative, str) or not isinstance(details, dict):
            raise TrainingError("dataset file manifest entry is invalid")
        path = (dataset_dir / relative).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise TrainingError("dataset manifest references a missing or out-of-directory file")
        if details.get("sha256") != _sha256(path):
            raise TrainingError(f"dataset file checksum mismatch: {relative}")
        return path

    feature_path = verified_path("training_rows.parquet", files["training_rows.parquet"])
    feature_rows = pq.read_table(feature_path).to_pylist()
    label_rows: list[dict[str, Any]] = []
    label_entries = [
        (relative, details)
        for relative, details in files.items()
        if relative.startswith("labels/") and relative.endswith(".parquet")
    ]
    if not label_entries:
        raise TrainingError("dataset manifest contains no partitioned labels")
    for relative, details in sorted(label_entries):
        label_rows.extend(pq.read_table(verified_path(relative, details)).to_pylist())
    return manifest, feature_rows, label_rows


def _aggregate_examples(
    feature_rows: Sequence[dict[str, Any]], label_rows: Sequence[dict[str, Any]]
) -> list[dict[str, Any]]:
    labels: dict[tuple[str, str, datetime], bool] = {}
    for row in label_rows:
        if (
            row.get("label") != LABEL_NAME
            or row.get("label_not_spoilage") is not True
            or row.get("data_origin") != "synthetic"
            or row.get("split") != "unsplit_synthetic_fixture"
            or not isinstance(row.get("value"), bool)
        ):
            raise TrainingError("label partition contains an unsupported or non-synthetic target")
        key = (row.get("tenant_pk"), row.get("bin_pk"), _timestamp(row.get("as_of"), "label.as_of"))
        if key in labels:
            raise TrainingError("dataset contains duplicate labels for a bin/time")
        labels[key] = row["value"]

    grouped: dict[tuple[str, str, datetime], list[dict[str, Any]]] = {}
    for row in feature_rows:
        if (
            row.get("data_origin") != "synthetic"
            or row.get("split") != "unsplit_synthetic_fixture"
        ):
            raise TrainingError("feature table contains a non-synthetic or pre-split row")
        key = (row.get("tenant_pk"), row.get("bin_pk"), _timestamp(row.get("as_of"), "feature.as_of"))
        grouped.setdefault(key, []).append(row)

    examples: list[dict[str, Any]] = []
    for key, rows in grouped.items():
        if key not in labels:
            continue
        values: list[float] = []
        for feature in FEATURES:
            available: list[float] = []
            for row in rows:
                value = row.get(feature)
                if value is None:
                    continue
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise TrainingError(f"feature {feature} must contain finite numeric values")
                available.append(float(value))
            values.append(sum(available) / len(available) if available else math.nan)
        examples.append({"as_of": key[2], "values": values, "label": int(labels[key])})
    examples.sort(key=lambda item: item["as_of"])
    if len(examples) < 3:
        raise TrainingError("too few feature/label timestamps align; generate a longer fixture")
    return examples


def _purged_time_splits(examples: Sequence[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Use contiguous 50/25/25 time blocks with a 24h+48h purge."""
    times = [row["as_of"] for row in examples]
    if times != sorted(times) or len(set(times)) != len(times):
        raise TrainingError("examples must have unique chronological bin timestamps")
    train_boundary = len(examples) // 2
    validation_boundary = (len(examples) * 3) // 4
    if train_boundary == 0 or validation_boundary >= len(examples):
        raise TrainingError("fixture is too short for chronological splits")
    train_end = examples[train_boundary - 1]["as_of"]
    validation_start = next(
        (i for i, row in enumerate(examples) if row["as_of"] > train_end + PURGE_HORIZON),
        len(examples),
    )
    validation_end = examples[validation_boundary - 1]["as_of"]
    test_start = next(
        (i for i, row in enumerate(examples) if row["as_of"] > validation_end + PURGE_HORIZON),
        len(examples),
    )
    splits = {
        "train": list(examples[:train_boundary]),
        "validation": list(examples[validation_start:validation_boundary]),
        "test": list(examples[test_start:]),
    }
    if any(not rows for rows in splits.values()):
        raise TrainingError("fixture is too short after the 72-hour feature/label purge; use a longer fixture")
    if len({row["label"] for row in splits["train"]}) < 2:
        raise TrainingError("training period must contain both synthetic label classes")
    return splits


def _sigmoid(score: float) -> float:
    if score >= 0:
        inverse = math.exp(-score)
        return 1.0 / (1.0 + inverse)
    exp_score = math.exp(score)
    return exp_score / (1.0 + exp_score)


def _fit_logistic(train: Sequence[dict[str, Any]], *, epochs: int = 1200) -> dict[str, Any]:
    width = len(FEATURES)
    means: list[float] = []
    scales: list[float] = []
    for column in range(width):
        present = [row["values"][column] for row in train if math.isfinite(row["values"][column])]
        if not present:
            raise TrainingError(f"training feature {FEATURES[column]} is entirely missing")
        mean = sum(present) / len(present)
        variance = sum((value - mean) ** 2 for value in present) / len(present)
        means.append(mean)
        scales.append(math.sqrt(variance) or 1.0)

    matrix = [
        [
            ((value if math.isfinite(value) else means[column]) - means[column]) / scales[column]
            for column, value in enumerate(row["values"])
        ]
        for row in train
    ]
    targets = [row["label"] for row in train]
    weights = [0.0] * width
    intercept = math.log((sum(targets) + 0.5) / (len(targets) - sum(targets) + 0.5))
    learning_rate = 0.08
    l2 = 0.01
    for _ in range(epochs):
        grad = [0.0] * width
        grad_intercept = 0.0
        for features, target in zip(matrix, targets, strict=True):
            probability = _sigmoid(intercept + sum(w * x for w, x in zip(weights, features, strict=True)))
            error = probability - target
            grad_intercept += error
            for column, value in enumerate(features):
                grad[column] += error * value
        count = len(matrix)
        intercept -= learning_rate * grad_intercept / count
        weights = [
            weight - learning_rate * (grad[column] / count + l2 * weight)
            for column, weight in enumerate(weights)
        ]
    return {"means": means, "scales": scales, "weights": weights, "intercept": intercept}


def _predict(model: dict[str, Any], values: Sequence[float]) -> float:
    standardized = [
        ((value if math.isfinite(value) else model["means"][index]) - model["means"][index])
        / model["scales"][index]
        for index, value in enumerate(values)
    ]
    score = model["intercept"] + sum(
        weight * value for weight, value in zip(model["weights"], standardized, strict=True)
    )
    return _sigmoid(score)


def _metrics(model: dict[str, Any], rows: Sequence[dict[str, Any]], train_prevalence: float) -> dict[str, Any]:
    predictions = [_predict(model, row["values"]) for row in rows]
    labels = [row["label"] for row in rows]
    epsilon = 1e-15
    brier = sum((prediction - label) ** 2 for prediction, label in zip(predictions, labels, strict=True)) / len(rows)
    log_loss = -sum(
        label * math.log(max(epsilon, prediction))
        + (1 - label) * math.log(max(epsilon, 1 - prediction))
        for prediction, label in zip(predictions, labels, strict=True)
    ) / len(rows)
    return {
        "samples": len(rows),
        "positive_rate": sum(labels) / len(labels),
        "accuracy_at_0_5": sum((prediction >= 0.5) == bool(label) for prediction, label in zip(predictions, labels, strict=True)) / len(labels),
        "brier_score": brier,
        "constant_train_prevalence_brier": sum((train_prevalence - label) ** 2 for label in labels) / len(labels),
        "log_loss": log_loss,
    }


def train_fixture(dataset_dir: Path, output_path: Path) -> dict[str, Any]:
    manifest, feature_rows, label_rows = _load_dataset(dataset_dir)
    examples = _aggregate_examples(feature_rows, label_rows)
    splits = _purged_time_splits(examples)
    model = _fit_logistic(splits["train"])
    prevalence = sum(row["label"] for row in splits["train"]) / len(splits["train"])
    metrics = {
        name: _metrics(model, rows, prevalence)
        for name, rows in splits.items()
    }
    beat_constant_baseline = (
        metrics["test"]["brier_score"] < metrics["test"]["constant_train_prevalence_brier"]
    )
    report = {
        "status": "exploratory synthetic-only fit; not accepted for deployment",
        "promotion_eligible": False,
        "held_out_result": (
            "logistic baseline beat the constant train-prevalence Brier comparator"
            if beat_constant_baseline
            else "logistic baseline did not beat the constant train-prevalence Brier comparator"
        ),
        "synthetic_only": True,
        "target": LABEL_NAME,
        "target_semantics": "synthetic future temperature/air-RH threshold excursion; not spoilage or agronomic risk",
        "dataset_hash": manifest["dataset_hash"],
        "fixture_scenario": manifest.get("scenario"),
        "fixture_seed": manifest.get("seed"),
        "feature_set_version": manifest.get("feature_set_version"),
        "python_version": platform.python_version(),
        "algorithm": "deterministic batch logistic regression (standardized features, training-fold mean imputation, L2=0.01)",
        "features": list(FEATURES),
        "prediction_horizon_hours": 48,
        "purge_hours": int(PURGE_HORIZON.total_seconds() // 3600),
        "split_time_ranges": {
            name: {"start": rows[0]["as_of"].isoformat(), "end": rows[-1]["as_of"].isoformat(), "samples": len(rows)}
            for name, rows in splits.items()
        },
        "metrics": metrics,
        "limitations": [
            "single synthetic tenant/site/bin; no site, season, crop, or weather-year generalization",
            "target is a fixture threshold excursion, not spoilage, damage, or agronomic risk",
            "metrics are exploratory and do not establish model quality or acceptance",
            "model is not connected to ml-scoring, risk-engine, alerts, or user-facing applications",
        ],
        "model": model,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{output_path.name}.tmp-", dir=output_path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(report, stream, sort_keys=True, indent=2, allow_nan=False)
            stream.write("\n")
        os.replace(temporary_name, output_path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True, help="synthetic corpus output directory")
    parser.add_argument("--output", type=Path, required=True, help="JSON report/model artifact path")
    args = parser.parse_args()
    try:
        report = train_fixture(args.dataset, args.output)
    except (OSError, RuntimeError, TrainingError) as exc:
        print(f"synthetic baseline failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({key: value for key, value in report.items() if key != "model"}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
