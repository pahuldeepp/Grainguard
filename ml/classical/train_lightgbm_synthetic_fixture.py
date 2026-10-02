"""Fit an exploratory LightGBM model to the authorized synthetic fixture only.

The target is a future synthetic sensor-threshold excursion. It is not a
spoilage, damage, or agronomic-risk model and cannot be deployed.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import importlib.util
from importlib.metadata import version as package_version
import json
import math
import os
from pathlib import Path
import platform
import secrets
import sys
import tempfile
from typing import Any, Sequence

from ml.classical.train_synthetic_fixture import (
    LABEL_NAME,
    FEATURES,
    PURGE_HORIZON,
    TrainingError,
    _sha256,
    _aggregate_examples,
    _fit_logistic,
    _load_dataset,
    _metrics as _logistic_metrics,
    _purged_time_splits,
)


PARAMETERS: dict[str, Any] = {
    "objective": "binary",
    "metric": "binary_logloss",
    "verbosity": -1,
    "boosting_type": "gbdt",
    "learning_rate": 0.03,
    "num_leaves": 7,
    "max_depth": 3,
    "min_data_in_leaf": 10,
    "lambda_l2": 1.0,
    "feature_fraction": 1.0,
    "bagging_fraction": 1.0,
    "deterministic": True,
    "force_col_wise": True,
    "num_threads": 1,
    "seed": 20260929,
    "feature_fraction_seed": 20260929,
    "bagging_seed": 20260929,
    "data_random_seed": 20260929,
}
BOOSTING_ROUNDS = 100


def _feature_indices(feature_names: Sequence[str] | None = None) -> tuple[str, ...]:
    names = tuple(FEATURES if feature_names is None else feature_names)
    if not names or len(set(names)) != len(names) or any(name not in FEATURES for name in names):
        raise TrainingError("feature subset must contain unique declared feature names")
    return names


def _matrix(
    rows: Sequence[dict[str, Any]], *, feature_names: Sequence[str] | None = None
) -> tuple[list[list[float]], list[int]]:
    names = _feature_indices(feature_names)
    indices = [FEATURES.index(name) for name in names]
    features: list[list[float]] = []
    labels: list[int] = []
    for row in rows:
        values = row["values"]
        if len(values) != len(FEATURES):
            raise TrainingError("feature vector width does not match the declared feature set")
        features.append([
            float(values[index]) if math.isfinite(values[index]) else math.nan
            for index in indices
        ])
        labels.append(int(row["label"]))
    return features, labels


def _predict(
    model: Any,
    rows: Sequence[dict[str, Any]],
    *,
    feature_names: Sequence[str] | None = None,
) -> list[float]:
    import numpy as np

    features, _ = _matrix(rows, feature_names=feature_names)
    values = np.asarray(features, dtype=np.float64)
    predictions = model.predict(values, num_threads=1)
    result = [float(value) for value in predictions]
    if any(not math.isfinite(value) or value < 0 or value > 1 for value in result):
        raise TrainingError("LightGBM returned a non-finite or out-of-range probability")
    return result


def _fit_lightgbm(
    rows: Sequence[dict[str, Any]],
    *,
    parameters: dict[str, Any] | None = None,
    boosting_rounds: int = BOOSTING_ROUNDS,
    feature_names: Sequence[str] | None = None,
) -> Any:
    try:
        import lightgbm as lgb
        import numpy as np
    except ImportError as exc:
        raise RuntimeError(
            "LightGBM experiment requires the pinned optional dependency; install with "
            "`python3 -m pip install -r ml/classical/requirements.txt`"
        ) from exc
    names = _feature_indices(feature_names)
    features, labels = _matrix(rows, feature_names=names)
    if len(set(labels)) < 2:
        raise TrainingError("training period must contain both synthetic label classes")
    train_set = lgb.Dataset(
        np.asarray(features, dtype=np.float64),
        label=np.asarray(labels, dtype=np.int32),
        feature_name=list(names),
    )
    # Fixed rounds avoid tuning against the class-degenerate synthetic validation
    # block. Validation remains an untouched diagnostic split, not a tuner.
    selected_parameters = dict(PARAMETERS if parameters is None else parameters)
    if isinstance(boosting_rounds, bool) or not isinstance(boosting_rounds, int) or boosting_rounds < 1:
        raise TrainingError("LightGBM boosting rounds must be a positive integer")
    return lgb.train(
        selected_parameters,
        train_set,
        num_boost_round=boosting_rounds,
        callbacks=[lgb.log_evaluation(period=0)],
    )


def _metrics(
    model: Any,
    rows: Sequence[dict[str, Any]],
    train_prevalence: float,
    *,
    feature_names: Sequence[str] | None = None,
) -> dict[str, Any]:
    predictions = _predict(model, rows, feature_names=feature_names)
    labels = [int(row["label"]) for row in rows]
    epsilon = 1e-15
    brier = sum((probability - label) ** 2 for probability, label in zip(predictions, labels, strict=True)) / len(labels)
    log_loss = -sum(
        label * math.log(max(epsilon, probability))
        + (1 - label) * math.log(max(epsilon, 1 - probability))
        for probability, label in zip(predictions, labels, strict=True)
    ) / len(labels)
    return {
        "samples": len(labels),
        "positive_rate": sum(labels) / len(labels),
        "accuracy_at_0_5": sum((probability >= 0.5) == bool(label) for probability, label in zip(predictions, labels, strict=True)) / len(labels),
        "brier_score": brier,
        "constant_train_prevalence_brier": sum((train_prevalence - label) ** 2 for label in labels) / len(labels),
        "log_loss": log_loss,
    }


def _verify_generated_fixture(
    manifest: dict[str, Any],
    expected_examples: Sequence[dict[str, Any]],
) -> dict[str, str]:
    """Rebuild the checked-in fixture corpus and compare training examples exactly."""
    repository = Path(__file__).resolve().parents[2]
    generator_path = repository / "tools" / "sensor-fixture" / "generate.py"
    builder_path = repository / "ml" / "corpus" / "build.py"
    feature_kernel_path = repository / "packages" / "ml-features" / "src" / "ml_features" / "kernel.py"
    feature_package_init_path = repository / "packages" / "ml-features" / "src" / "ml_features" / "__init__.py"
    shared_trainer_path = Path(__file__).with_name("train_synthetic_fixture.py")
    sources = {
        "trainer": Path(__file__).resolve(),
        "shared_logistic_trainer": shared_trainer_path,
        "fixture_generator": generator_path,
        "corpus_builder": builder_path,
        "feature_kernel": feature_kernel_path,
        "feature_package_init": feature_package_init_path,
    }
    source_hashes = {
        name: _sha256(path)
        for name, path in sources.items()
        if path.is_file()
    }
    expected_source_keys = {
        "fixture_generator": "fixture_generator_sha256",
        "corpus_builder": "corpus_builder_sha256",
        "feature_kernel": "feature_kernel_sha256",
    }
    if len(source_hashes) != len(sources):
        raise TrainingError("approved fixture generation source is missing")
    for source_name, manifest_key in expected_source_keys.items():
        if manifest.get(manifest_key) != source_hashes[source_name]:
            raise TrainingError(f"dataset was not produced by the current {source_name}")
    if manifest.get("layout_version") != "synthetic-feature-prototype-v2":
        raise TrainingError("unsupported synthetic fixture corpus layout")
    if manifest.get("fixture_version") != 1:
        raise TrainingError("unsupported synthetic fixture version")
    scenario = manifest.get("scenario")
    seed = manifest.get("seed")
    days = manifest.get("fixture_days")
    onset_fraction = manifest.get("onset_fraction")
    if scenario not in {"baseline", "warming"}:
        raise TrainingError("unsupported synthetic fixture scenario")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
        raise TrainingError("synthetic fixture seed is invalid")
    if isinstance(days, bool) or not isinstance(days, int) or not 4 <= days <= 30:
        raise TrainingError("synthetic fixture duration is invalid")
    if (
        isinstance(onset_fraction, bool)
        or not isinstance(onset_fraction, (int, float))
        or not math.isfinite(onset_fraction)
        or not 0.2 <= onset_fraction <= 0.8
    ):
        raise TrainingError("synthetic fixture onset_fraction is invalid")
    input_hashes = manifest.get("input_sha256")
    if not isinstance(input_hashes, dict):
        raise TrainingError("corpus manifest has no fixture source checksums")

    generator_spec = importlib.util.spec_from_file_location("greenguard_sensor_fixture", generator_path)
    if generator_spec is None or generator_spec.loader is None:
        raise TrainingError("cannot load the approved synthetic fixture generator")
    generator = importlib.util.module_from_spec(generator_spec)
    generator_spec.loader.exec_module(generator)

    # Corpus build imports the shared feature package by its source path.
    feature_source = repository / "packages" / "ml-features" / "src"
    if str(feature_source) not in sys.path:
        sys.path.insert(0, str(feature_source))
    if str(repository) not in sys.path:
        sys.path.insert(0, str(repository))
    from ml.corpus.build import build_corpus

    with tempfile.TemporaryDirectory(prefix="greenguard-verified-synthetic-") as temporary:
        temporary_dir = Path(temporary)
        fixture_dir = temporary_dir / "fixture"
        fixture_dir.mkdir()
        fixture_manifest = generator.generate(
            fixture_dir,
            scenario=scenario,
            days=days,
            seed=seed,
            onset_fraction=onset_fraction,
        )
        if (
            fixture_manifest.get("reading_sha256") != input_hashes.get("readings.jsonl")
            or fixture_manifest.get("label_sha256") != input_hashes.get("labels.jsonl")
        ):
            raise TrainingError("fixture source checksums do not match the checked-in deterministic generator")
        if _sha256(fixture_dir / "manifest.json") != manifest.get("fixture_manifest_sha256"):
            raise TrainingError("fixture manifest checksum does not match deterministic regeneration")

        rebuilt_dir = temporary_dir / "corpus"
        build_corpus(
            fixture_dir / "readings.jsonl",
            fixture_dir / "labels.jsonl",
            rebuilt_dir,
            sample_minutes=manifest.get("sample_minutes", 60),
            sequence_steps=manifest.get("sequence_steps", 96),
            sequence_stride_steps=manifest.get("sequence_stride_steps", 8),
            hmac_secret=secrets.token_bytes(32),
        )
        _, rebuilt_features, rebuilt_labels = _load_dataset(rebuilt_dir)
        rebuilt_examples = _aggregate_examples(rebuilt_features, rebuilt_labels)

    if len(rebuilt_examples) != len(expected_examples):
        raise TrainingError("dataset examples do not match regenerated synthetic fixture")
    for expected, rebuilt in zip(expected_examples, rebuilt_examples, strict=True):
        if expected["as_of"] != rebuilt["as_of"] or expected["label"] != rebuilt["label"]:
            raise TrainingError("dataset targets or timestamps differ from regenerated synthetic fixture")
        for expected_value, rebuilt_value in zip(expected["values"], rebuilt["values"], strict=True):
            if math.isnan(expected_value) and math.isnan(rebuilt_value):
                continue
            if expected_value != rebuilt_value:
                raise TrainingError("dataset feature values differ from regenerated synthetic fixture")
    return source_hashes


def train_fixture(dataset_dir: Path, output_path: Path) -> dict[str, Any]:
    try:
        import lightgbm as lgb
        import numpy as np
    except ImportError as exc:
        raise RuntimeError(
            "LightGBM experiment requires the pinned optional dependency; install with "
            "`python3 -m pip install -r ml/classical/requirements.txt`"
        ) from exc

    manifest, feature_rows, label_rows = _load_dataset(dataset_dir)
    examples = _aggregate_examples(feature_rows, label_rows)
    source_hashes = _verify_generated_fixture(manifest, examples)
    splits = _purged_time_splits(examples)
    _, train_y = _matrix(splits["train"])
    if len(set(train_y)) < 2:
        raise TrainingError("training period must contain both synthetic label classes")
    booster = _fit_lightgbm(splits["train"])
    logistic = _fit_logistic(splits["train"])
    prevalence = sum(train_y) / len(train_y)
    metrics = {name: _metrics(booster, rows, prevalence) for name, rows in splits.items()}
    logistic_metrics = {
        name: _logistic_metrics(logistic, rows, prevalence)
        for name, rows in splits.items()
    }
    beat_constant_baseline = metrics["test"]["brier_score"] < metrics["test"]["constant_train_prevalence_brier"]
    beat_logistic = metrics["test"]["brier_score"] < logistic_metrics["test"]["brier_score"]
    model_text = booster.model_to_string()
    report = {
        "status": "exploratory synthetic-only fit; not accepted for deployment",
        "promotion_eligible": False,
        "held_out_result": (
            "LightGBM beat both fixed logistic and constant-prevalence Brier comparators"
            if beat_constant_baseline and beat_logistic
            else "LightGBM did not beat both fixed logistic and constant-prevalence Brier comparators"
        ),
        "synthetic_only": True,
        "target": LABEL_NAME,
        "target_semantics": "synthetic future temperature/air-RH threshold excursion; not spoilage or agronomic risk",
        "dataset_hash": manifest["dataset_hash"],
        "fixture_scenario": manifest.get("scenario"),
        "fixture_seed": manifest.get("seed"),
        "feature_set_version": manifest.get("feature_set_version"),
        "python_version": platform.python_version(),
        "platform": platform.platform(),
        "machine_architecture": platform.machine(),
        "lightgbm_version": lgb.__version__,
        "numpy_version": np.__version__,
        "pyarrow_version": __import__("pyarrow").__version__,
        "scipy_version": package_version("scipy"),
        "narwhals_version": package_version("narwhals"),
        "source_sha256": source_hashes,
        "algorithm": "LightGBM GBDT (single thread, deterministic mode, fixed parameters)",
        "parameters": PARAMETERS,
        "boosting_rounds": BOOSTING_ROUNDS,
        "features": list(FEATURES),
        "prediction_horizon_hours": 48,
        "purge_hours": int(PURGE_HORIZON.total_seconds() // 3600),
        "split_time_ranges": {
            name: {"start": rows[0]["as_of"].isoformat(), "end": rows[-1]["as_of"].isoformat(), "samples": len(rows)}
            for name, rows in splits.items()
        },
        "metrics": metrics,
        "logistic_comparator_metrics": logistic_metrics,
        "model_text_sha256": hashlib.sha256(model_text.encode()).hexdigest(),
        "model_text": model_text,
        "limitations": [
            "single synthetic tenant/site/bin; no site, season, crop, or weather-year generalization",
            "target is a fixture threshold excursion, not spoilage, damage, or agronomic risk",
            "metrics are exploratory and do not establish model quality or acceptance",
            "model is not connected to ml-scoring, risk-engine, alerts, or user-facing applications",
            "synthetic validation/test blocks can be class-degenerate; this fixture is not a basis for model selection",
            "LightGBM parameters are fixed in advance; no synthetic validation/test result was used for tuning",
        ],
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
        print(f"synthetic LightGBM experiment failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({key: value for key, value in report.items() if key != "model_text"}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
