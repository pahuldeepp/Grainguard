"""Purged rolling-origin I2 backtest on deterministic synthetic grain-bin runs."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import random
import sys
import tempfile
from typing import Any

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "packages" / "ml-features" / "src"))
sys.path.insert(0, str(ROOT / "tools" / "grain-sim"))
from ml.corpus.build_bin_corpus import build_bin_corpus
from ml.classical.train_synthetic_fixture import FEATURES, _fit_logistic, _predict as logistic_predict
from ml.classical.train_lightgbm_synthetic_fixture import PARAMETERS, _fit_lightgbm, _predict as lgb_predict

from simulate import START as SIM_START, simulate  # noqa: E402
LABEL_HORIZON = timedelta(hours=48)
FEATURE_CONTEXT = timedelta(hours=24)
PURGE_HORIZON = FEATURE_CONTEXT + LABEL_HORIZON
TEST_WINDOW = timedelta(hours=24)
FOLD_CUTOFF_HOURS = (72, 96, 120, 144)
RUN_SPECS = tuple(
    (seed, "wet-pocket" if seed % 4 != 0 else "aeration")
    for seed in (10, 11, 12, 13, 14, 15, 16, 17)
)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _time(value: datetime) -> datetime:
    return value.astimezone(timezone.utc)


def _load_run(dataset: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = json.loads((dataset / "manifest.json").read_text())
    feature_path = dataset / "bin_features.parquet"
    label_path = dataset / "labels.parquet"
    if manifest.get("synthetic_only") is not True or manifest.get("label_not_spoilage") is not True:
        raise ValueError("I2 simulator backtest accepts only synthetic non-spoilage corpora")
    if manifest.get("split") != "unsplit_synthetic_run":
        raise ValueError("I2 split logic owns all train/test separation")
    if manifest["files"]["bin_features.parquet"]["sha256"] != _sha(feature_path):
        raise ValueError("bin feature checksum mismatch")
    if manifest["files"]["labels.parquet"]["sha256"] != _sha(label_path):
        raise ValueError("label checksum mismatch")
    feature_rows = pq.read_table(feature_path).to_pylist()
    label_rows = pq.read_table(label_path).to_pylist()
    labels = {(row["run_pk"], _time(row["as_of"])): int(row["value"]) for row in label_rows}
    examples = []
    for row in feature_rows:
        key = (row["run_pk"], _time(row["as_of"]))
        if key not in labels:
            raise ValueError("bin feature row has no exact run/time label")
        values = [float(row[name]) if isinstance(row.get(name), (int, float)) and not isinstance(row.get(name), bool) else math.nan for name in FEATURES]
        examples.append({
            "as_of": key[1], "run_pk": key[0], "values": values, "label": labels[key],
            "temperature_c_spread_latest": row.get("temperature_c_spread_latest"),
        })
    return manifest, examples


def _brier(rows: list[dict[str, Any]], predictions: list[float]) -> float:
    return sum((p - row["label"]) ** 2 for row, p in zip(rows, predictions, strict=True)) / len(rows)


def _paired_run_interval(logistic_rows: list[dict[str, Any]], lightgbm_rows: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, dict[str, list[tuple[int, float]]]] = {}
    for model, rows in (("logistic", logistic_rows), ("lightgbm", lightgbm_rows)):
        for row in rows:
            grouped.setdefault(row["run_pk"], {}).setdefault(model, []).append((row["label"], row["prediction"]))
    differences = []
    for models in grouped.values():
        if set(models) != {"logistic", "lightgbm"}:
            raise ValueError("run-level paired model outputs are incomplete")
        briers = {
            model: sum((prediction - label) ** 2 for label, prediction in values) / len(values)
            for model, values in models.items()
        }
        differences.append(briers["logistic"] - briers["lightgbm"])
    # Sort paired run-level differences, not HMAC pseudonyms: rotating the
    # corpus key must not change statistical output for identical observations.
    differences.sort()
    rng = random.Random(20260930)
    bootstrap = sorted(
        sum(rng.choice(differences) for _ in differences) / len(differences)
        for _ in range(4000)
    )
    return {
        "unit": "simulator run; logistic Brier minus LightGBM Brier",
        "runs": len(differences), "mean_difference": sum(differences) / len(differences),
        "bootstrap_95_percentile_interval": [bootstrap[99], bootstrap[3900]],
        "positive_means_lightgbm_lower_brier": True,
    }


def _folds(examples: list[dict[str, Any]], start: datetime) -> list[dict[str, Any]]:
    folds = []
    for index, cutoff_hours in enumerate(FOLD_CUTOFF_HOURS, start=1):
        cutoff = start + timedelta(hours=cutoff_hours)
        test_start = cutoff + PURGE_HORIZON
        test_end = test_start + TEST_WINDOW
        train = [row for row in examples if row["as_of"] < cutoff]
        test = [row for row in examples if test_start <= row["as_of"] < test_end]
        if not train or not test:
            raise ValueError(f"rolling fold {index} is empty")
        if max(row["as_of"] for row in train) + PURGE_HORIZON >= min(row["as_of"] for row in test):
            raise ValueError(f"rolling fold {index} leaks across the 72-hour feature/label horizon")
        if len({row["label"] for row in train}) != 2:
            raise ValueError(f"rolling fold {index} train period lacks both classes")
        folds.append({"fold": index, "train": train, "test": test, "cutoff": cutoff, "test_start": test_start, "test_end": test_end})
    return folds


def run(output: Path, *, secret: bytes | None = None) -> dict[str, Any]:
    key = secret or os.environ.get("GG_CORPUS_HMAC_KEY", "").encode()
    if len(key) < 32:
        raise ValueError("GG_CORPUS_HMAC_KEY must contain at least 32 bytes")
    with tempfile.TemporaryDirectory(prefix="gg-i2-sim-backtest-") as temporary:
        root = Path(temporary)
        all_examples: list[dict[str, Any]] = []
        run_manifests = []
        for seed, scenario in RUN_SPECS:
            run_root = root / f"run-{seed}-{scenario}"
            sim_dir, corpus_dir = run_root / "sim", run_root / "corpus"
            simulate(sim_dir, scenario=scenario, days=10, seed=seed)
            corpus_manifest = build_bin_corpus(sim_dir, corpus_dir, key)
            _, examples = _load_run(corpus_dir)
            all_examples.extend(examples)
            run_manifests.append({
                "seed": seed, "scenario": scenario, "run_pk": corpus_manifest["run_pk"],
                "corpus_dataset_id": corpus_manifest["dataset_id"],
                "rows": len(examples), "positive_rate": sum(row["label"] for row in examples) / len(examples),
            })
        # All generated runs share the same fixed simulator start timestamp.
        folds = _folds(all_examples, SIM_START)
        predictions_by_model: dict[str, list[dict[str, Any]]] = {"logistic": [], "lightgbm": [], "spread_rule": [], "prevalence": []}
        fold_reports = []
        for fold in folds:
            train, test = fold["train"], fold["test"]
            prevalence = sum(row["label"] for row in train) / len(train)
            logistic = _fit_logistic(train)
            lightgbm = _fit_lightgbm(train, parameters=dict(PARAMETERS), boosting_rounds=100)
            predictions = {
                "logistic": [logistic_predict(logistic, row["values"]) for row in test],
                "lightgbm": lgb_predict(lightgbm, test),
                # A fixed spatial spread heuristic is a simple, interpretable comparator.
                "spread_rule": [1.0 if (row["temperature_c_spread_latest"] or 0) >= 5.0 else 0.0 for row in test],
                "prevalence": [prevalence] * len(test),
            }
            metrics = {
                name: {"samples": len(test), "positive_rate": sum(row["label"] for row in test) / len(test),
                       "brier_score": _brier(test, values)}
                for name, values in predictions.items()
            }
            for name, values in predictions.items():
                predictions_by_model[name].extend({"run_pk": row["run_pk"], "label": row["label"], "prediction": value} for row, value in zip(test, values, strict=True))
            fold_reports.append({
                "fold": fold["fold"], "training_cutoff": fold["cutoff"].isoformat(),
                "purge_hours": int(PURGE_HORIZON.total_seconds() // 3600), "test_start": fold["test_start"].isoformat(), "test_end_exclusive": fold["test_end"].isoformat(),
                "train_rows": len(train), "train_positive_rate": prevalence,
                "test_rows": len(test), "test_positive_rate": metrics["logistic"]["positive_rate"],
                "metrics": metrics,
            })
        model_scores = {
            name: sum(item["brier_score"] for item in (fold["metrics"][name] for fold in fold_reports)) / len(fold_reports)
            for name in predictions_by_model
        }
        report = {
            "status": "exploratory synthetic-only I2 backtest; not validated for product use",
            "synthetic_only": True, "promotion_eligible": False,
            "target": "simulated_hotspot_onset_48h",
            "target_semantics": "simulator hotspot state is false at as_of and becomes true at least once within the next 48 hours; not spoilage or agronomic risk",
            "run_count": len(RUN_SPECS), "run_specs": run_manifests,
            "row_count": len(all_examples), "overall_positive_rate": sum(row["label"] for row in all_examples) / len(all_examples),
            "method": "four fixed expanding-window rolling-origin folds; 72-hour purge for 24-hour feature context plus 48-hour target horizon; folds are comparative only and are not an independent final evaluation set",
            "folds": fold_reports, "mean_fold_brier": model_scores,
            "paired_run_uncertainty": _paired_run_interval(predictions_by_model["logistic"], predictions_by_model["lightgbm"]),
            "candidate_comparison": "fixed logistic, fixed LightGBM recipe, fixed spatial-spread rule, and training-prevalence baseline; fold metrics are descriptive and no winner is selected",
            "promotion_decision": "none; nested selection and an untouched outer holdout are required before selecting or claiming a model",
            "source_sha256": {
                "backtest_runner": _sha(Path(__file__).resolve()),
                "simulator": _sha(ROOT / "tools/grain-sim/simulate.py"),
                "bin_corpus_builder": _sha(ROOT / "ml/corpus/build_bin_corpus.py"),
                "feature_kernel": _sha(ROOT / "packages/ml-features/src/ml_features/kernel.py"),
                "logistic": _sha(ROOT / "ml/classical/train_synthetic_fixture.py"),
                "lightgbm": _sha(ROOT / "ml/classical/train_lightgbm_synthetic_fixture.py"),
            },
            "limitations": [
                "all bins, labels, and measurements are simulator-generated with uncalibrated coefficients",
                "run seeds are deterministic variations, not independent farms or observed seasons",
                "does not prove spoilage forecasting, agronomic validity, or real-world generalization",
                "model outputs remain offline and cannot affect risk-engine, alerts, notifications, or user-facing claims",
            ],
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n")
        return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.output), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
