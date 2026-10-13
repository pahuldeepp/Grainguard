"""Evaluate a fixed LightGBM recipe across independent synthetic fixture runs.

This is an offline experiment on synthetic future threshold-excursion labels.
Fixture runs, rather than adjacent timestamps, define train/validation/test
groups so windows from one generated run can never leak across the split.
It is not a spoilage model and can never be promoted for product use.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import secrets
import sys
import tempfile
from typing import Any, Iterable
from importlib.metadata import version as package_version

from ml.classical.train_lightgbm_synthetic_fixture import (
    PARAMETERS,
    BOOSTING_ROUNDS,
    _fit_lightgbm,
    _fit_logistic,
    _load_dataset,
    _matrix,
    _metrics,
)
from ml.classical.train_synthetic_fixture import (
    FEATURES,
    LABEL_NAME,
    TrainingError,
    _aggregate_examples,
    _metrics as _logistic_metrics,
)


# The recipe and fixture groups are fixed before model fitting. Validation is
# diagnostic only; test runs are untouched until the one final evaluation.
FIXTURE_SPECS: dict[str, tuple[tuple[int, float], ...]] = {
    "train": tuple((1100 + index, fraction) for index, fraction in enumerate((0.30, 0.36, 0.42, 0.48, 0.54, 0.60, 0.66, 0.72))),
    "validation": tuple((2200 + index, fraction) for index, fraction in enumerate((0.33, 0.45, 0.57, 0.69))),
    # A fresh, larger replication holdout, registered after the earlier
    # 8-run report was reviewed. These seeds are not used for candidate choice.
    "test": tuple(
        (9000 + index, (0.26, 0.32, 0.38, 0.44, 0.50, 0.56, 0.62, 0.68, 0.74, 0.80)[index % 10])
        for index in range(24)
    ),
}

# A small, fixed candidate set. It is selected only by four-fold CV grouped by
# whole training fixture run. Neither the separate validation runs nor the
# final test runs participate in candidate selection.
LIGHTGBM_CANDIDATES: tuple[dict[str, Any], ...] = (
    {"name": "fixed_reference", "parameters": {}, "boosting_rounds": BOOSTING_ROUNDS},
    {"name": "shallow_regularized", "parameters": {"num_leaves": 3, "max_depth": 2, "min_data_in_leaf": 20, "lambda_l2": 5.0}, "boosting_rounds": 100},
    {"name": "shallow_longer", "parameters": {"num_leaves": 3, "max_depth": 2, "min_data_in_leaf": 10, "lambda_l2": 10.0, "learning_rate": 0.03}, "boosting_rounds": 200},
    {"name": "medium_regularized", "parameters": {"num_leaves": 7, "max_depth": 3, "min_data_in_leaf": 20, "lambda_l2": 5.0, "learning_rate": 0.05}, "boosting_rounds": 100},
    {"name": "medium_small_leaves", "parameters": {"num_leaves": 7, "max_depth": 3, "min_data_in_leaf": 30, "lambda_l2": 10.0}, "boosting_rounds": 100},
    {"name": "deeper_regularized", "parameters": {"num_leaves": 15, "max_depth": 4, "min_data_in_leaf": 20, "lambda_l2": 10.0}, "boosting_rounds": 100},
    {"name": "deeper_fast", "parameters": {"num_leaves": 15, "max_depth": 4, "min_data_in_leaf": 10, "lambda_l2": 5.0, "learning_rate": 0.05}, "boosting_rounds": 50},
    {"name": "shallow_fast", "parameters": {"num_leaves": 3, "max_depth": 2, "min_data_in_leaf": 10, "lambda_l2": 10.0, "learning_rate": 0.05}, "boosting_rounds": 50},
    {"name": "fixed_shorter", "parameters": {}, "boosting_rounds": 50},
)

ORIGINAL_FEATURES = (
    "temperature_c_mean_1h",
    "temperature_c_mean_24h",
    "temperature_c_delta_24h",
    "relative_humidity_percent_mean_1h",
    "relative_humidity_percent_mean_24h",
    "relative_humidity_percent_delta_24h",
    "coverage_24h",
)

# Add a predeclared feature ablation. It uses the same grouped training-only
# folds and candidate recipes; the held-out test set is never used to choose it.
LIGHTGBM_CANDIDATES = LIGHTGBM_CANDIDATES + (
    {"name": "trend_features_reference", "parameters": {}, "boosting_rounds": BOOSTING_ROUNDS, "features": list(FEATURES)},
    {"name": "trend_features_shallow", "parameters": {"num_leaves": 3, "max_depth": 2, "min_data_in_leaf": 20, "lambda_l2": 5.0}, "boosting_rounds": 100, "features": list(FEATURES)},
)
LIGHTGBM_CANDIDATES = tuple(
    {"features": list(ORIGINAL_FEATURES), **candidate}
    for candidate in LIGHTGBM_CANDIDATES
    if "features" not in candidate
) + tuple(candidate for candidate in LIGHTGBM_CANDIDATES if "features" in candidate)


def _grouped_training_folds(
    rows: list[dict[str, Any]], *, max_folds: int = 4
) -> list[tuple[list[dict[str, Any]], list[dict[str, Any]], tuple[str, ...]]]:
    """Return deterministic folds that hold out complete fixture runs."""
    runs = sorted({str(row["fixture_run_id"]) for row in rows})
    if len(runs) < 2:
        raise TrainingError("grouped model selection requires at least two training fixture runs")
    fold_count = min(max_folds, len(runs))
    groups = [tuple(runs[index::fold_count]) for index in range(fold_count)]
    folds = []
    for held_out in groups:
        held_out_set = set(held_out)
        train = [row for row in rows if str(row["fixture_run_id"]) not in held_out_set]
        validation = [row for row in rows if str(row["fixture_run_id"]) in held_out_set]
        if not train or not validation:
            raise TrainingError("grouped model-selection fold is empty")
        train_runs = {str(row["fixture_run_id"]) for row in train}
        validation_runs = {str(row["fixture_run_id"]) for row in validation}
        if train_runs & validation_runs or validation_runs != held_out_set:
            raise TrainingError("fixture run leaked across grouped model-selection fold")
        folds.append((train, validation, held_out))
    return folds


def _select_lightgbm_candidate(
    training_rows: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Select by equal-weight mean Brier across training-only held-out runs."""
    folds = _grouped_training_folds(training_rows)
    results: list[dict[str, Any]] = []
    for candidate in LIGHTGBM_CANDIDATES:
        full_parameters = {**PARAMETERS, **candidate["parameters"]}
        fold_results = []
        for fold_index, (fold_train, fold_test, held_out_runs) in enumerate(folds):
            _, labels = _matrix(fold_train)
            if len(set(labels)) < 2:
                raise TrainingError("grouped training fold does not contain both synthetic label classes")
            model = _fit_lightgbm(
                fold_train,
                parameters=full_parameters,
                boosting_rounds=candidate["boosting_rounds"],
                feature_names=candidate["features"],
            )
            predictions = _metrics(model, fold_test, sum(labels) / len(labels), feature_names=candidate["features"])
            per_run = []
            for run_id in held_out_runs:
                run_rows = [row for row in fold_test if row["fixture_run_id"] == run_id]
                per_run.append({
                    "fixture_run_id": run_id,
                    "brier_score": _metrics(model, run_rows, sum(labels) / len(labels), feature_names=candidate["features"])["brier_score"],
                })
            fold_results.append({
                "fold": fold_index,
                "held_out_fixture_runs": list(held_out_runs),
                "pooled_brier_score": predictions["brier_score"],
                "per_run_brier": per_run,
            })
        run_scores = [
            record["brier_score"]
            for fold in fold_results
            for record in fold["per_run_brier"]
        ]
        results.append({
            "name": candidate["name"],
            "parameters": full_parameters,
            "boosting_rounds": candidate["boosting_rounds"],
            "features": candidate["features"],
            "mean_per_run_brier": sum(run_scores) / len(run_scores),
            "training_runs_scored": len(run_scores),
            "folds": fold_results,
        })
    # Candidate order is the deterministic tie-breaker.
    selected = min(results, key=lambda record: record["mean_per_run_brier"])
    return selected, results


def _source_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _fixture_id(scenario: str, seed: int, onset_fraction: float, input_sha256: dict[str, str]) -> str:
    canonical = json.dumps(
        {
            "scenario": scenario,
            "seed": seed,
            "onset_fraction": onset_fraction,
            "input_sha256": input_sha256,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(canonical).hexdigest()


def _bootstrap_mean_interval(values: list[float], *, samples: int = 4000, seed: int = 20260929) -> dict[str, float]:
    """Deterministic percentile interval resampling independent fixture runs."""
    if len(values) < 2:
        raise TrainingError("at least two independent test fixture runs are required for an interval")
    import numpy as np

    rng = np.random.default_rng(seed)
    means = np.mean(rng.choice(np.asarray(values, dtype=np.float64), size=(samples, len(values)), replace=True), axis=1)
    return {
        "confidence_level": 0.95,
        "resampling_unit": "independent_fixture_run",
        "runs": len(values),
        "mean": float(np.mean(values)),
        "lower": float(np.quantile(means, 0.025)),
        "upper": float(np.quantile(means, 0.975)),
        "method": "percentile bootstrap; descriptive only for this synthetic fixture family",
    }


def _load_generator(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location("greenguard_collection_sensor_fixture", path)
    if spec is None or spec.loader is None:
        raise TrainingError("cannot load the approved deterministic sensor fixture generator")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    return generator


def _fixture_threshold_rule_brier(rows: list[dict[str, Any]]) -> float:
    """Fixed synthetic label rule: current aggregate readings meet both thresholds."""
    temperature_index = FEATURES.index("temperature_c_mean_1h")
    humidity_index = FEATURES.index("relative_humidity_percent_mean_1h")
    predictions = [
        1.0
        if math.isfinite(row["values"][temperature_index])
        and math.isfinite(row["values"][humidity_index])
        and row["values"][temperature_index] >= 25.0
        and row["values"][humidity_index] >= 65.0
        else 0.0
        for row in rows
    ]
    return sum(
        (prediction - row["label"]) ** 2
        for prediction, row in zip(predictions, rows, strict=True)
    ) / len(rows)


def evaluate_collection(
    output_path: Path,
    *,
    fixture_specs: dict[str, tuple[tuple[int, float], ...]] = FIXTURE_SPECS,
    days: int = 14,
) -> dict[str, Any]:
    if set(fixture_specs) != {"train", "validation", "test"}:
        raise TrainingError("fixture collection must define train, validation, and test groups")
    if any(len(fixture_specs[name]) < 2 for name in fixture_specs):
        raise TrainingError("each fixture group must contain at least two independent runs")
    if not 9 <= days <= 30:
        raise TrainingError("collection fixtures must be 9–30 days to cover the purged label horizon")
    flattened = [item for group in fixture_specs.values() for item in group]
    if len(set(flattened)) != len(flattened):
        raise TrainingError("a seed/onset pair cannot appear in more than one fixture group")
    seeds = [seed for seed, _ in flattened]
    if len(set(seeds)) != len(seeds):
        raise TrainingError("fixture seeds must be unique across split groups to keep noise streams independent")

    repository = Path(__file__).resolve().parents[2]
    generator_path = repository / "tools" / "sensor-fixture" / "generate.py"
    builder_path = repository / "ml" / "corpus" / "build.py"
    kernel_path = repository / "packages" / "ml-features" / "src" / "ml_features" / "kernel.py"
    feature_init_path = repository / "packages" / "ml-features" / "src" / "ml_features" / "__init__.py"
    source_hashes = {
        "collection_trainer": _source_hash(Path(__file__).resolve()),
        "single_fixture_trainer": _source_hash(Path(__file__).with_name("train_lightgbm_synthetic_fixture.py")),
        "shared_logistic_trainer": _source_hash(Path(__file__).with_name("train_synthetic_fixture.py")),
        "fixture_generator": _source_hash(generator_path),
        "corpus_builder": _source_hash(builder_path),
        "feature_kernel": _source_hash(kernel_path),
        "feature_package_init": _source_hash(feature_init_path),
    }
    generator = _load_generator(generator_path)
    feature_source = repository / "packages" / "ml-features" / "src"
    if str(feature_source) not in sys.path:
        sys.path.insert(0, str(feature_source))
    if str(repository) not in sys.path:
        sys.path.insert(0, str(repository))
    from ml.corpus.build import build_corpus

    grouped_examples: dict[str, list[dict[str, Any]]] = {name: [] for name in fixture_specs}
    fixture_records: dict[str, list[dict[str, Any]]] = {name: [] for name in fixture_specs}
    with tempfile.TemporaryDirectory(prefix="greenguard-lightgbm-fixture-collection-") as temporary:
        root = Path(temporary)
        for group_name, specs in fixture_specs.items():
            for seed, onset_fraction in specs:
                if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
                    raise TrainingError("fixture seed must be a non-negative integer")
                if not math.isfinite(onset_fraction) or not 0.2 <= onset_fraction <= 0.8:
                    raise TrainingError("fixture onset fraction must be between 0.2 and 0.8")
                fixture_dir = root / f"{group_name}-{seed}-{int(onset_fraction * 1000)}" / "fixture"
                fixture_dir.mkdir(parents=True)
                generated = generator.generate(
                    fixture_dir,
                    scenario="warming",
                    days=days,
                    seed=seed,
                    onset_fraction=onset_fraction,
                )
                corpus_dir = fixture_dir.parent / "corpus"
                corpus = build_corpus(
                    fixture_dir / "readings.jsonl",
                    fixture_dir / "labels.jsonl",
                    corpus_dir,
                    hmac_secret=secrets.token_bytes(32),
                )
                manifest, features, labels = _load_dataset(corpus_dir)
                examples = _aggregate_examples(features, labels)
                # These files were generated immediately above by this process,
                # so rebuilding the full feature corpus a second time adds cost
                # without adding provenance. Bind the generated fixture and
                # corpus to the current approved source hashes instead.
                expected_corpus_sources = {
                    "fixture_generator_sha256": source_hashes["fixture_generator"],
                    "corpus_builder_sha256": source_hashes["corpus_builder"],
                    "feature_kernel_sha256": source_hashes["feature_kernel"],
                }
                if any(manifest.get(key) != value for key, value in expected_corpus_sources.items()):
                    raise TrainingError("generated corpus provenance does not match the current approved sources")
                fixture_manifest_path = fixture_dir / "manifest.json"
                if _source_hash(fixture_manifest_path) != manifest.get("fixture_manifest_sha256"):
                    raise TrainingError("generated corpus is not bound to its sensor fixture manifest")
                if (
                    manifest.get("input_sha256", {}).get("readings.jsonl") != generated["reading_sha256"]
                    or manifest.get("input_sha256", {}).get("labels.jsonl") != generated["label_sha256"]
                ):
                    raise TrainingError("generated corpus input checksums do not match its sensor fixture")
                stable_id = _fixture_id("warming", seed, onset_fraction, manifest["input_sha256"])
                for example in examples:
                    grouped_examples[group_name].append({**example, "fixture_run_id": stable_id})
                run_labels = [example["label"] for example in examples]
                fixture_records[group_name].append(
                    {
                        "fixture_run_id": stable_id,
                        "scenario": generated["scenario"],
                        "seed": seed,
                        "onset_fraction": onset_fraction,
                        "trigger_step": generated["trigger_step"],
                        "input_sha256": manifest["input_sha256"],
                        "source_sha256": source_hashes,
                        "samples": len(run_labels),
                        "positive_rate": sum(run_labels) / len(run_labels),
                    }
                )

    split_labels = {name: [row["label"] for row in rows] for name, rows in grouped_examples.items()}
    for group_name in ("train", "validation", "test"):
        if len(set(split_labels[group_name])) < 2:
            raise TrainingError(f"{group_name} group must contain both synthetic classes")
    run_ids = {
        group_name: [record["fixture_run_id"] for record in records]
        for group_name, records in fixture_records.items()
    }
    if len(set(run_ids["train"] + run_ids["validation"] + run_ids["test"])) != len(flattened):
        raise TrainingError("fixture run identity collision across split groups")

    train_rows = grouped_examples["train"]
    _, train_y = _matrix(train_rows)
    if len(set(train_y)) < 2:
        raise TrainingError("training fixture runs must contain both classes")
    selected_candidate, candidate_results = _select_lightgbm_candidate(train_rows)
    inner_fold_count = len(_grouped_training_folds(train_rows))
    trend_features = set(FEATURES) - set(ORIGINAL_FEATURES)
    trend_features_selected = bool(trend_features & set(selected_candidate["features"]))
    model = _fit_lightgbm(
        train_rows,
        parameters=selected_candidate["parameters"],
        boosting_rounds=selected_candidate["boosting_rounds"],
        feature_names=selected_candidate["features"],
    )
    logistic = _fit_logistic(train_rows)
    prevalence = sum(train_y) / len(train_y)
    metrics = {
        group: _metrics(model, rows, prevalence, feature_names=selected_candidate["features"])
        for group, rows in grouped_examples.items()
    }
    logistic_metrics = {
        group: _logistic_metrics(logistic, rows, prevalence)
        for group, rows in grouped_examples.items()
    }
    test_rows = grouped_examples["test"]
    per_run: list[dict[str, Any]] = []
    for record in fixture_records["test"]:
        rows = [row for row in test_rows if row["fixture_run_id"] == record["fixture_run_id"]]
        run_metrics = _metrics(model, rows, prevalence, feature_names=selected_candidate["features"])
        logistic_run_metrics = _logistic_metrics(logistic, rows, prevalence)
        per_run.append({
            "fixture_run_id": record["fixture_run_id"],
            "seed": record["seed"],
            "onset_fraction": record["onset_fraction"],
            "samples": len(rows),
            "positive_rate": run_metrics["positive_rate"],
            "lightgbm_brier": run_metrics["brier_score"],
            "logistic_brier": logistic_run_metrics["brier_score"],
            "constant_train_prevalence_brier": run_metrics["constant_train_prevalence_brier"],
            "fixture_threshold_rule_brier": _fixture_threshold_rule_brier(rows),
        })
    brier_interval = _bootstrap_mean_interval([row["lightgbm_brier"] for row in per_run])
    logistic_interval = _bootstrap_mean_interval([row["logistic_brier"] for row in per_run], seed=20260930)
    paired_difference_interval = _bootstrap_mean_interval(
        [row["logistic_brier"] - row["lightgbm_brier"] for row in per_run],
        seed=20260931,
    )
    baseline_interval = _bootstrap_mean_interval(
        [row["constant_train_prevalence_brier"] for row in per_run], seed=20261001
    )
    threshold_interval = _bootstrap_mean_interval(
        [row["fixture_threshold_rule_brier"] for row in per_run], seed=20261002
    )
    source_paths = {
        "collection_trainer": Path(__file__).resolve(),
        "single_fixture_trainer": Path(__file__).with_name("train_lightgbm_synthetic_fixture.py"),
        "shared_logistic_trainer": Path(__file__).with_name("train_synthetic_fixture.py"),
        "fixture_generator": generator_path,
        "corpus_builder": builder_path,
        "feature_kernel": kernel_path,
        "feature_package_init": feature_init_path,
    }
    if any(_source_hash(path) != source_hashes[name] for name, path in source_paths.items()):
        raise TrainingError("an experiment source changed while the fixture collection was being evaluated")
    recipe = {
        "algorithm": "LightGBM GBDT",
        "selection_candidate": selected_candidate["name"],
        "parameters": selected_candidate["parameters"],
        "boosting_rounds": selected_candidate["boosting_rounds"],
        "features": selected_candidate["features"],
        "target": LABEL_NAME,
        "label_horizon_hours": 48,
        "fixture_days": days,
        "selection_policy": f"lowest equal-weight mean per-run Brier over {inner_fold_count} deterministic folds of training runs only; validation and test are excluded",
        "grouping_policy": "whole independent fixture run assigned to exactly one outer split and one inner training-only fold",
    }
    recipe_hash = hashlib.sha256(json.dumps(recipe, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    model_text = model.model_to_string()
    report = {
        "status": "exploratory synthetic-only multi-run evaluation; not accepted for deployment",
        "synthetic_only": True,
        "promotion_eligible": False,
        "target": LABEL_NAME,
        "target_semantics": "synthetic future temperature/air-RH threshold excursion; not spoilage or agronomic risk",
        "model_selection_status": "small predeclared candidate set selected by grouped CV within training runs; validation is diagnostic and test is evaluated once",
        "evaluation_unit": "independent generated sensor fixture run; adjacent timestamps are correlated and are not treated as independent bootstrap samples",
        "recipe_sha256": recipe_hash,
        "recipe": recipe,
        "model_text_sha256": hashlib.sha256(model_text.encode()).hexdigest(),
        "model_text": model_text,
        "split_run_counts": {name: len(records) for name, records in fixture_records.items()},
        "fixture_runs": fixture_records,
        "metrics": metrics,
        "logistic_comparator_metrics": logistic_metrics,
        "model_selection": {
            "selection_metric": "equal-weight mean Brier score across independent training fixture runs",
            "inner_cv_folds": inner_fold_count,
            "train_runs_only": True,
            "validation_used_for_selection": False,
            "test_used_for_selection": False,
            "selected_candidate": selected_candidate["name"],
            "selected_training_cv_mean_per_run_brier": selected_candidate["mean_per_run_brier"],
            "candidates": candidate_results,
        },
        "test_per_fixture": per_run,
        "test_brier_by_run_bootstrap_95_ci": brier_interval,
        "test_logistic_brier_by_run_bootstrap_95_ci": logistic_interval,
        "test_logistic_minus_lightgbm_brier_by_run_bootstrap_95_ci": {
            **paired_difference_interval,
            "positive_means": "LightGBM lower Brier than logistic regression",
            "method": "paired percentile bootstrap of per-run Brier differences; descriptive only for this synthetic fixture family",
        },
        "test_constant_prevalence_brier_by_run_bootstrap_95_ci": baseline_interval,
        "test_fixture_threshold_rule_brier_by_run_bootstrap_95_ci": threshold_interval,
        "held_out_result": (
            "LightGBM lower mean per-run Brier than every fixed comparator"
            if paired_difference_interval["lower"] > 0
            and brier_interval["mean"] < baseline_interval["mean"]
            and brier_interval["mean"] < threshold_interval["mean"]
            else (
                "LightGBM was better than the fixed threshold and prevalence baselines, but no clear paired advantage over logistic regression was established"
                if brier_interval["mean"] < baseline_interval["mean"]
                and brier_interval["mean"] < threshold_interval["mean"]
                and paired_difference_interval["lower"] <= 0 <= paired_difference_interval["upper"]
                else "LightGBM did not beat every fixed comparator on mean per-run Brier"
            )
        ),
        "python_version": platform.python_version(),
        "platform": platform.platform(),
        "machine_architecture": platform.machine(),
        "lightgbm_version": package_version("lightgbm"),
        "numpy_version": package_version("numpy"),
        "pyarrow_version": package_version("pyarrow"),
        "scipy_version": package_version("scipy"),
        "narwhals_version": package_version("narwhals"),
        "source_sha256": source_hashes,
        "limitations": [
            "all records are deterministic synthetic fixtures, not real or tenant telemetry",
            "fixture signals are simple generated ramps, not a grain-physics simulator",
            "the target is a synthetic threshold excursion, not spoilage, damage, or agronomic risk",
            "fixture runs vary only seed and event onset; no site, season, crop, weather-year, or sensor-installation generalization is established",
            "confidence intervals resample a small number of fixture runs and are descriptive, not product acceptance evidence",
            "a small predeclared candidate set is selected by grouped training-only CV; this is not broad hyperparameter optimization and validation/test metrics do not select the recipe",
            (
                "one-hour temperature and humidity trends were evaluated as a feature ablation and were selected by training-only grouped CV"
                if trend_features_selected
                else "one-hour temperature and humidity trends were evaluated as a feature ablation but were not selected by training-only grouped CV"
            ),
            "the model is not connected to ml-scoring, risk-engine, alerts, or user-facing applications",
        ],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output_path.name}.tmp-", dir=output_path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(report, stream, sort_keys=True, indent=2, allow_nan=False)
            stream.write("\n")
        os.replace(temporary_name, output_path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)
    return report


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--days", type=int, default=14)
    args = parser.parse_args(argv)
    try:
        report = evaluate_collection(args.output, days=args.days)
    except (OSError, RuntimeError, TrainingError, ValueError) as exc:
        print(f"synthetic LightGBM collection evaluation failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({key: value for key, value in report.items() if key != "model_text"}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
