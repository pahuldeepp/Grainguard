"""Isolated LightGBM/logistic subprocess for same-split diagnostics.

This process intentionally does not import PyTorch; the local PyTorch and
LightGBM wheels bundle OpenMP runtimes that conflict when loaded together.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta
import hashlib
import json
import math
from pathlib import Path

import pyarrow.parquet as pq

from ml.deep_learning.comparison_contract import (
    SequenceDataError, TemporalSplit, binary_metrics, frozen_comparison,
    split_by_time, verify_frozen_comparison,
)
from ml.classical.train_synthetic_fixture import FEATURES, _fit_logistic, _predict as logistic_predict
from ml.classical.train_lightgbm_synthetic_fixture import _fit_lightgbm, _predict as lightgbm_predict


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(corpus_dirs: list[Path], splits: dict[str, set[int]] | None = None,
        temporal_split: dict | None = None, frozen: dict | None = None) -> dict:
    if (splits is None) == (temporal_split is None):
        raise ValueError("provide exactly one of whole-run seeds or a temporal split")
    run_seed: dict[str, int] = {}
    all_sequence_keys: set[tuple[str, object]] = set()
    seen_sequence_rows: set[tuple[str, object, object]] = set()
    labels: dict[tuple[str, object], int] = {}
    features: dict[tuple[str, object], dict] = {}
    for directory in corpus_dirs:
        manifest = json.loads((directory / "manifest.json").read_text())
        if manifest.get("synthetic_only") is not True or manifest.get("label_not_spoilage") is not True:
            raise ValueError("classical baseline accepts only synthetic non-spoilage corpora")
        run_pk, seed = str(manifest["run_pk"]), int(manifest["seed"])
        if run_pk in run_seed:
            raise ValueError("duplicate simulator run in corpus inputs")
        run_seed[run_pk] = seed
        for filename in ("sequence_windows.parquet", "labels.parquet", "bin_features.parquet"):
            path = directory / filename
            if manifest.get("files", {}).get(filename, {}).get("sha256") != _sha(path):
                raise ValueError(f"checksum mismatch for {filename}")
        for row in pq.read_table(directory / "sequence_windows.parquet").to_pylist():
            sequence_row_key = (run_pk, row["as_of"], row.get("device_pk"))
            if sequence_row_key in seen_sequence_rows:
                raise ValueError("duplicate sequence row for device and timestamp")
            seen_sequence_rows.add(sequence_row_key)
            all_sequence_keys.add((run_pk, row["as_of"]))
        for row in pq.read_table(directory / "labels.parquet").to_pylist():
            if (row.get("label") != "simulated_hotspot_onset_48h" or row.get("label_not_spoilage") is not True
                    or not isinstance(row.get("value"), bool)):
                raise ValueError("unexpected label in classical baseline input")
            key = (run_pk, row["as_of"])
            if key in labels:
                raise ValueError("duplicate label timestamp in corpus inputs")
            labels[key] = int(row["value"])
        for row in pq.read_table(directory / "bin_features.parquet").to_pylist():
            key = (run_pk, row["as_of"])
            if key in features:
                raise ValueError("duplicate bin feature timestamp in corpus inputs")
            features[key] = row
    rows_by_split = {name: [] for name in ("train", "validation", "test")}
    split_keys = {name: [] for name in rows_by_split}
    ordered_keys = sorted(all_sequence_keys, key=lambda pair: (pair[0], pair[1]))
    if temporal_split is not None:
        try:
            split = TemporalSplit(
                train_end=datetime.fromisoformat(temporal_split["train_end_exclusive"]),
                validation_start=datetime.fromisoformat(temporal_split["validation_start_inclusive"]),
                validation_end=datetime.fromisoformat(temporal_split["validation_end_exclusive"]),
                test_start=datetime.fromisoformat(temporal_split["test_start_inclusive"]),
                test_end=datetime.fromisoformat(temporal_split["test_end_exclusive"]),
                context=timedelta(hours=temporal_split["context_hours"]),
                label_horizon=timedelta(hours=temporal_split["label_horizon_hours"]),
                train_seeds=tuple(temporal_split["train_seeds"]),
                validation_seeds=tuple(temporal_split["validation_seeds"]),
                test_seeds=tuple(temporal_split["test_seeds"]),
            )
            if temporal_split != split.as_dict():
                raise SequenceDataError("temporal split declaration does not match validated boundaries")
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("invalid temporal split definition") from exc
        selected = split_by_time([at for _, at in ordered_keys],
                                 [run_seed[run] for run, _ in ordered_keys], split)
        assignments = {ordered_keys[index]: name for name, indices in selected.items() for index in indices}
    else:
        seed_groups = list(splits.values())
        if (set(splits) != {"train", "validation", "test"} or any(not group for group in seed_groups)
                or sum(map(len, seed_groups)) != len(set().union(*seed_groups))
                or set().union(*seed_groups) != set(run_seed.values())):
            raise ValueError("whole-run seeds must exactly cover disjoint nonempty splits")
        assignments = {key: name for key in ordered_keys for name, seeds in splits.items()
                       if run_seed[key[0]] in seeds}
    for key in ordered_keys:
        run_pk, as_of = key
        if key not in labels or key not in features:
            raise ValueError("sequence timestamp lacks its matching label or bin feature")
        row = features[key]
        values = []
        for name in FEATURES:
            value = row.get(name)
            values.append(float(value) if isinstance(value, (int, float)) and math.isfinite(value) else float("nan"))
        example = {"run_pk": run_pk, "values": values, "label": labels[key]}
        if key not in assignments:
            continue  # Purged timestamps and seed cohorts are intentionally unused.
        name = assignments[key]
        rows_by_split[name].append(example)
        split_keys[name].append((run_pk, as_of, labels[key]))
    if any(not rows for rows in rows_by_split.values()):
        raise ValueError("every whole-run split needs matched examples")
    definition = temporal_split if temporal_split is not None else {name: sorted(seeds) for name, seeds in splits.items()}
    actual_frozen = frozen_comparison(corpus_dirs, definition, split_keys)
    if frozen is not None:
        verify_frozen_comparison(actual_frozen, frozen)
    train = rows_by_split["train"]
    if len({row["label"] for row in train}) < 2:
        raise ValueError("training split needs both target classes")
    models = {
        "logistic_i2_features": (_fit_logistic(train), logistic_predict),
        "lightgbm_i2_features": (_fit_lightgbm(train), lightgbm_predict),
    }
    results = {}
    for model_name, (model, predict) in models.items():
        results[model_name] = {}
        for split_name in ("validation", "test"):
            rows = rows_by_split[split_name]
            y = [row["label"] for row in rows]
            if model_name == "lightgbm_i2_features":
                probabilities = predict(model, rows)
            else:
                probabilities = [predict(model, row["values"]) for row in rows]
            results[model_name][split_name] = binary_metrics(y, probabilities)
    results["_split_fingerprints"] = actual_frozen["split_fingerprints"]
    results["_frozen_comparison"] = actual_frozen
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, action="append", required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--time-split-json", type=Path)
    group.add_argument("--train-seeds", type=int, nargs="+")
    parser.add_argument("--validation-seeds", type=int, nargs="+")
    parser.add_argument("--test-seeds", type=int, nargs="+")
    parser.add_argument("--frozen-split", type=Path)
    args = parser.parse_args()
    frozen = json.loads(args.frozen_split.read_text()) if args.frozen_split else None
    if args.time_split_json:
        result = run(args.corpus, temporal_split=json.loads(args.time_split_json.read_text()), frozen=frozen)
    else:
        if not args.validation_seeds or not args.test_seeds:
            parser.error("whole-run splits require train, validation, and test seeds")
        result = run(args.corpus, {
            "train": set(args.train_seeds), "validation": set(args.validation_seeds),
            "test": set(args.test_seeds),
        }, frozen=frozen)
    args.output.write_text(json.dumps(result, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
