"""Validate and evaluate a public stored-wheat insect-activity proxy dataset.

This is a research-only benchmark. It does not predict spoilage and cannot
produce a model eligible for product use or promotion.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys
from typing import Any

PROXY_ID = "mendeley-stored-wheat-insect-activity-v1"
SOURCE_URL = "https://data.mendeley.com/datasets/53ckhtd8gj/1"
FEATURES = ("previous_mean_temperature_c", "previous_mean_grain_moisture_percent",
            "previous_total_insect_count", "sampling_gap_occasions")


class ProxyDataError(ValueError):
    pass


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_rows(path: Path) -> list[dict[str, Any]]:
    """Read a normalized CSV contract; no pandas/openpyxl dependency required."""
    import csv
    required = {"silo_id", "time_index", "temperature_c", "grain_moisture_percent", "insect_count"}
    with path.open(newline="", encoding="utf-8-sig") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            raise ProxyDataError(f"normalized CSV must contain columns: {', '.join(sorted(required))}")
        rows = []
        for line, raw in enumerate(reader, 2):
            try:
                row = {"silo_id": raw["silo_id"].strip(), "time_index": int(raw["time_index"]),
                       "temperature_c": float(raw["temperature_c"]),
                       "grain_moisture_percent": float(raw["grain_moisture_percent"]),
                       "insect_count": int(raw["insect_count"])}
            except (TypeError, ValueError, KeyError) as exc:
                raise ProxyDataError(f"line {line}: invalid/missing value") from exc
            if (not row["silo_id"] or row["time_index"] < 1 or row["insect_count"] < 0
                    or not all(math.isfinite(row[k]) for k in ("temperature_c", "grain_moisture_percent"))):
                raise ProxyDataError(f"line {line}: values out of range")
            rows.append(row)
    if not rows:
        raise ProxyDataError("dataset is empty")
    return rows


def build_examples(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Aggregate contemporaneous traps; predict the next occasion from past only."""
    grouped: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault((row["silo_id"], row["time_index"]), []).append(row)
    by_silo: dict[str, list[tuple[int, tuple[float, float, int]]]] = {}
    for (silo, time), group in grouped.items():
        n = len(group)
        current = (sum(r["temperature_c"] for r in group) / n,
                   sum(r["grain_moisture_percent"] for r in group) / n,
                   sum(r["insect_count"] for r in group))
        by_silo.setdefault(silo, []).append((time, current))
    examples = []
    for silo, samples in by_silo.items():
        samples.sort()
        for (prior_time, prior), (next_time, target) in zip(samples, samples[1:]):
            # Do not bridge missing occasions: this is explicitly next observed
            # sampling occasion, and the gap is retained as a feature.
            features = [prior[0], prior[1], prior[2], next_time - prior_time]
            examples.append({"silo_id": silo, "time_index": next_time, "x": features,
                             "y": float(target[2])})
    if len({e["silo_id"] for e in examples}) < 3:
        raise ProxyDataError("at least three independent silos are required for descriptive silo holdout")
    return examples


def _ridge_predict(train: list[dict[str, Any]], test: list[dict[str, Any]]) -> tuple[list[float], list[float]]:
    import numpy as np
    x_train = np.asarray([e["x"] for e in train], dtype=float)
    x_test = np.asarray([e["x"] for e in test], dtype=float)
    y_train = np.asarray([e["y"] for e in train], dtype=float)
    # Standardize from training silo data only; intercept is not penalized.
    mean, scale = x_train.mean(axis=0), x_train.std(axis=0)
    scale[scale == 0] = 1.0
    a = np.column_stack((np.ones(len(train)), (x_train - mean) / scale))
    b = np.column_stack((np.ones(len(test)), (x_test - mean) / scale))
    penalty = np.diag([0.0] + [1.0] * x_train.shape[1])
    coef = np.linalg.solve(a.T @ a + penalty, a.T @ y_train)
    pred = np.maximum(0.0, b @ coef)
    baseline = np.full(len(test), float(y_train.mean()))
    return pred.tolist(), baseline.tolist()


def evaluate(csv_path: Path, output_path: Path) -> dict[str, Any]:
    rows = load_rows(csv_path)
    examples = build_examples(rows)
    sidecar_path = csv_path.with_suffix(csv_path.suffix + ".source.json")
    try:
        source_record = json.loads(sidecar_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProxyDataError("normalized data requires its source provenance sidecar") from exc
    if (not isinstance(source_record, dict)
            or source_record.get("schema_version") != "greenguard-public-proxy-source-v1"
            or source_record.get("dataset_id") != PROXY_ID
            or source_record.get("license") != "CC BY 4.0"
            or source_record.get("normalized_csv_sha256") != _sha(csv_path)
            or any(not isinstance(source_record.get(field), str) or not source_record[field].strip()
                   for field in ("source_title", "source_file_sha256", "normalizer_sha256"))
            or any(not re.fullmatch(r"[0-9a-f]{64}", source_record[field])
                   for field in ("source_file_sha256", "normalizer_sha256"))
            or source_record.get("production_eligible") is not False
            or source_record.get("promotion_eligible") is not False):
        raise ProxyDataError("source provenance sidecar is invalid or does not match normalized CSV")
    silos = sorted({row["silo_id"] for row in examples})
    folds = []
    for silo in silos:
        train = [e for e in examples if e["silo_id"] != silo]
        test = [e for e in examples if e["silo_id"] == silo]
        model, baseline = _ridge_predict(train, test)
        actual = [e["y"] for e in test]
        mae = lambda pred: sum(abs(a - p) for a, p in zip(actual, pred)) / len(actual)
        folds.append({"held_out_silo": silo, "train_examples": len(train), "test_examples": len(test),
                      "ridge_mae_insect_count": mae(model), "training_mean_baseline_mae_insect_count": mae(baseline)})
    # Gate fixed before interpreting these results: at least five independent
    # silos and a lower MAE than the baseline in every held-out silo. This
    # tiny dataset cannot pass the independent-group minimum.
    gate_reasons = []
    if len(silos) < 5:
        gate_reasons.append("requires at least five independent held-out silos; observed three")
    if any(fold["ridge_mae_insect_count"] >= fold["training_mean_baseline_mae_insect_count"]
           for fold in folds):
        gate_reasons.append("ridge candidate must beat the training-mean baseline in every held-out silo")
    result = {
        "schema_version": "greenguard-proxy-evaluation-v1",
        "dataset_id": PROXY_ID,
        "dataset_sha256": _sha(csv_path),
        "source_url": SOURCE_URL,
        "source_title": source_record["source_title"],
        "source_file_sha256": source_record["source_file_sha256"],
        "normalizer_sha256": source_record["normalizer_sha256"],
        "evaluator_sha256": _sha(Path(__file__)),
        "license": "CC BY 4.0 (attribute the source when sharing derived artifacts)",
        "task": "next_observed_sampling_occasion_total_stored_wheat_insect_count",
        "target_semantics": "measured insect activity/count; not spoilage, mildew, mycotoxin, or commercial risk",
        "features": list(FEATURES),
        "split": "leave-one-silo-out; three silo folds; descriptive only",
        "raw_rows": len(rows), "silo_count": len(silos), "examples": len(examples), "folds": folds,
        "data_origin": "public_research_proxy", "synthetic_only": False,
        "production_eligible": False, "promotion_eligible": False,
        "candidate_decision": "REJECTED",
        "candidate_gate": {"minimum_independent_silos": 5,
                           "must_beat_training_mean_baseline_each_fold": True,
                           "decision_reasons": gate_reasons},
        "registry_action": "rejected research evaluation receipt only; no model artifact registered; serving registry unchanged",
        "limitations": ["Only three silos and 15 reported sampling occasions; estimates are highly uncertain.",
                        "The source is an insect infestation study, not a spoilage study.",
                        "Silo-held-out scores are descriptive and do not establish commercial generalization.",
                        "Only prior sampling measurements are features; sensor values at the target occasion are excluded."],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, sort_keys=True, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", required=True, type=Path, help="normalized source CSV; keep outside Git")
    parser.add_argument("--output", required=True, type=Path, help="research-only evidence JSON")
    args = parser.parse_args(argv)
    try:
        result = evaluate(args.csv, args.output)
    except (ProxyDataError, OSError, ImportError, ValueError) as exc:
        print(json.dumps({"status": "rejected", "error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
