"""Rebuild immutable offline candidates from the checked-in grain-sim seed recipe.

Synthetic labels cannot qualify a production model. This command never reads
tenant data, changes a registry, selects a champion, or performs promotion.
"""

from __future__ import annotations

import argparse
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import platform
import sys
import tempfile
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ml.classical.backtest_grain_sim import (  # noqa: E402
    RUN_SPECS, SIM_START, _folds, _load_run, build_bin_corpus, simulate,
)
from ml.classical.train_synthetic_fixture import (  # noqa: E402
    FEATURES, _fit_logistic, _metrics as logistic_metrics,
    PURGE_HORIZON,
)
from ml.classical.train_lightgbm_synthetic_fixture import (  # noqa: E402
    BOOSTING_ROUNDS, PARAMETERS, _fit_lightgbm, _metrics as lightgbm_metrics,
)

# Public, deterministic IDs for generated runs only. Never use a tenant key.
SYNTHETIC_ONLY_KEY = b"GreenGuard offline candidate synthetic IDs 2026 v1"
SOURCE_FILES = (
    "ml/classical/retrain_synthetic_candidate.py",
    "ml/classical/backtest_grain_sim.py",
    "ml/classical/train_synthetic_fixture.py",
    "ml/classical/train_lightgbm_synthetic_fixture.py",
    "ml/corpus/build_bin_corpus.py",
    "tools/grain-sim/simulate.py",
    "packages/ml-features/src/ml_features/kernel.py",
    "packages/ml-features/src/ml_features/__init__.py",
    "packages/grain-physics/src/grain_physics/__init__.py",
    "packages/grain-physics/src/grain_physics/equilibrium_moisture.py",
    "packages/grain-physics/src/grain_physics/psychrometrics.py",
)


def _canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _generated_examples(root: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    examples = []
    inputs = []
    for seed, scenario in RUN_SPECS:
        run_root = root / f"run-{seed}-{scenario}"
        sim_dir, corpus_dir = run_root / "sim", run_root / "corpus"
        simulate(sim_dir, scenario=scenario, days=10, seed=seed)
        corpus = build_bin_corpus(sim_dir, corpus_dir, secret=SYNTHETIC_ONLY_KEY)
        _, rows = _load_run(corpus_dir)
        examples.extend(rows)
        inputs.append({
            "seed": seed, "scenario": scenario, "days": 10,
            "simulator_manifest_sha256": _sha((sim_dir / "manifest.json").read_bytes()),
            "corpus_manifest_sha256": _sha((corpus_dir / "manifest.json").read_bytes()),
            "corpus_dataset_id": corpus["dataset_id"], "rows": len(rows),
        })
    return examples, inputs


def _rows_sha(rows: list[dict[str, Any]]) -> str:
    # The digest binds split membership, observed features, and labels. Missing
    # features are represented as null instead of non-standard JSON NaN.
    import math

    return _sha(_canonical([
        {"run_pk": row["run_pk"], "as_of": row["as_of"].isoformat(),
         "label": row["label"],
         "values": [value if math.isfinite(value) else None for value in row["values"]]}
        for row in sorted(rows, key=lambda item: (item["run_pk"], item["as_of"]))
    ]))


def _evaluate(examples: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, bytes]]:
    reports = []
    artifacts: dict[str, bytes] = {}
    for fold in _folds(examples, SIM_START):
        train, test = fold["train"], fold["test"]
        prevalence = sum(row["label"] for row in train) / len(train)
        logistic = _fit_logistic(train)
        lightgbm = _fit_lightgbm(train, parameters=dict(PARAMETERS), boosting_rounds=BOOSTING_ROUNDS)
        prefix = f"fold-{fold['fold']}"
        artifacts[f"{prefix}.logistic.json"] = _canonical({
            "architecture": "synthetic-logistic-v1", "features": list(FEATURES),
            "synthetic_only": True, "production_eligible": False, "model": logistic,
        })
        # LightGBM's text model includes no output path or wall-clock timestamp.
        artifacts[f"{prefix}.lightgbm.txt"] = lightgbm.model_to_string().encode()
        reports.append({
            "fold": fold["fold"], "training_cutoff": fold["cutoff"].isoformat(),
            "purge_hours": int(PURGE_HORIZON.total_seconds() // 3600), "test_start": fold["test_start"].isoformat(),
            "test_end_exclusive": fold["test_end"].isoformat(),
            "train_latest": max(row["as_of"] for row in train).isoformat(),
            "test_earliest": min(row["as_of"] for row in test).isoformat(),
            "train_rows": len(train), "test_rows": len(test),
            "train_rows_sha256": _rows_sha(train), "test_rows_sha256": _rows_sha(test),
            "metrics": {"logistic": logistic_metrics(logistic, test, prevalence),
                        "lightgbm": lightgbm_metrics(lightgbm, test, prevalence)},
        })
    return reports, artifacts


def _write_package(output_root: Path, report: dict[str, Any], artifacts: dict[str, bytes]) -> Path:
    for name, data in artifacts.items():
        if (not isinstance(name, str) or name in {"", ".", "..", "manifest.json", "evaluation.json"}
                or "/" in name or "\\" in name or not isinstance(data, bytes)):
            raise ValueError("candidate artifact names must be safe, reserved-free filenames with byte contents")
    files = {**artifacts, "evaluation.json": _canonical(report)}
    manifest = {
        "schema_version": "greenguard-offline-candidate-package-v1",
        "data_origin": "synthetic_grain_sim", "synthetic_only": True,
        "production_eligible": False, "promotion_eligible": False,
        "selected_model": None, "champion": None,
        "files": {name: {"sha256": _sha(data), "bytes": len(data)}
                  for name, data in sorted(files.items())},
    }
    candidate_id = _sha(_canonical(manifest))
    manifest["candidate_id"] = candidate_id
    files["manifest.json"] = _canonical(manifest)
    destination = output_root / candidate_id
    output_root.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if (not destination.is_dir() or destination.is_symlink()
                or {path.name for path in destination.iterdir()} != set(files)
                or any((destination / name).is_symlink()
                       or not (destination / name).is_file()
                       or (destination / name).read_bytes() != data for name, data in files.items())):
            raise ValueError("existing immutable candidate package has been modified")
        verify_package(destination)
        return destination
    with tempfile.TemporaryDirectory(prefix=".offline-candidate-", dir=output_root) as temporary:
        staging = Path(temporary)
        for name, data in files.items():
            (staging / name).write_bytes(data)
        staging.rename(destination)
    return destination


def verify_package(package: Path) -> dict[str, Any]:
    """Verify the self-contained integrity and non-promotion claims of a package.

    This establishes content integrity only. It does not authenticate who built
    the package, validate model quality, or authorize registry promotion.
    """
    if package.is_symlink() or not package.is_dir():
        raise ValueError("candidate package must be a real directory")
    manifest_path = package / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("candidate package manifest is missing or unsafe")
    manifest_bytes = manifest_path.read_bytes()
    try:
        manifest = json.loads(manifest_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("candidate package manifest is invalid JSON") from exc
    if not isinstance(manifest, dict) or manifest_bytes != _canonical(manifest):
        raise ValueError("candidate package manifest is not canonical")
    candidate_id = manifest.get("candidate_id")
    unsigned_manifest = {key: value for key, value in manifest.items() if key != "candidate_id"}
    if (not isinstance(candidate_id, str) or len(candidate_id) != 64
            or _sha(_canonical(unsigned_manifest)) != candidate_id
            or package.name != candidate_id):
        raise ValueError("candidate ID does not match its canonical manifest")
    if (manifest.get("schema_version") != "greenguard-offline-candidate-package-v1"
            or manifest.get("data_origin") != "synthetic_grain_sim"
            or manifest.get("synthetic_only") is not True
            or manifest.get("production_eligible") is not False
            or manifest.get("promotion_eligible") is not False
            or manifest.get("selected_model") is not None
            or manifest.get("champion") is not None):
        raise ValueError("candidate package does not carry the required synthetic-only non-promotion claims")
    file_records = manifest.get("files")
    if not isinstance(file_records, dict) or not file_records or "evaluation.json" not in file_records:
        raise ValueError("candidate package file inventory is invalid")
    expected_names = set(file_records) | {"manifest.json"}
    try:
        actual_names = {entry.name for entry in package.iterdir()}
    except OSError as exc:
        raise ValueError("candidate package inventory cannot be read") from exc
    if actual_names != expected_names:
        raise ValueError("candidate package contains missing or unexpected files")
    for name, record in file_records.items():
        if (not isinstance(name, str) or name in {"", ".", "..", "manifest.json"}
                or "/" in name or "\\" in name or not isinstance(record, dict)
                or set(record) != {"sha256", "bytes"}):
            raise ValueError("candidate package file inventory contains an unsafe entry")
        path = package / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("candidate package contains a missing or unsafe artifact")
        data = path.read_bytes()
        if (record.get("sha256") != _sha(data)
                or type(record.get("bytes")) is not int
                or record.get("bytes") != len(data)):
            raise ValueError("candidate package artifact hash or size does not match")
    try:
        evaluation = json.loads((package / "evaluation.json").read_bytes())
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("candidate evaluation is invalid JSON") from exc
    if (not isinstance(evaluation, dict) or evaluation.get("synthetic_only") is not True
            or evaluation.get("production_eligible") is not False
            or evaluation.get("promotion_eligible") is not False
            or evaluation.get("selected_model") is not None
            or evaluation.get("champion") is not None):
        raise ValueError("candidate evaluation violates the synthetic-only non-promotion boundary")
    return manifest


def run(output_root: Path, *, promote: object = None, champion: object = None) -> Path:
    if promote is not None or champion is not None:
        raise ValueError("offline synthetic candidates refuse every promotion or champion setting")
    # No input path, tenant key, database URL, or seed override is accepted.
    with tempfile.TemporaryDirectory(prefix="gg-offline-candidate-input-") as temporary:
        examples, inputs = _generated_examples(Path(temporary))
        folds, artifacts = _evaluate(examples)
    report = {
        "schema_version": "greenguard-offline-candidate-evaluation-v1",
        "synthetic_only": True, "production_eligible": False, "promotion_eligible": False,
        "target": "simulated_hotspot_onset_48h", "label_not_spoilage": True,
        "target_semantics": "simulator false-to-true hotspot transition within 48 hours",
        "inputs": inputs, "row_count": len(examples), "folds": folds,
        "method": "fixed I2 expanding temporal windows with 72-hour feature-context plus label-horizon purge",
        "candidate_recipes": {
            "logistic": {"epochs": 1200, "learning_rate": 0.08, "l2": 0.01},
            "lightgbm": {"parameters": PARAMETERS, "boosting_rounds": BOOSTING_ROUNDS},
        },
        "selection": "none; each fixed candidate is evaluated descriptively against training prevalence",
        "source_sha256": {name: _sha((ROOT / name).read_bytes()) for name in SOURCE_FILES},
        "environment": {"python": platform.python_version(),
                        **{name: version(name) for name in ("pyarrow", "lightgbm", "numpy")}},
        "limitations": [
            "Synthetic labels cannot qualify a production model.",
            "Simulator parameters are uncalibrated; labels are not observed spoilage or agronomic outcomes.",
            "These comparative folds overlap in training history; they are not an untouched outer holdout.",
            "No model is selected; no champion, promotion, registry, serving, or tenant data is touched.",
            "Artifact hashes reproduce on the same recorded source and runtime versions; cross-platform bitwise identity is not promised.",
        ],
    }
    return _write_package(output_root.resolve(), report, artifacts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--output-root", type=Path, default=Path("evidence/intelligence/offline-candidates"))
    parser.add_argument("--promote", nargs="?", const=True, default=None,
                        help="always refused, including false/off values")
    parser.add_argument("--champion", nargs="?", const=True, default=None,
                        help="always refused; this command never selects a champion")
    args = parser.parse_args()
    if args.promote is not None or args.champion is not None:
        parser.error("offline synthetic candidates refuse every promotion or champion setting")
    print(run(args.output_root))


if __name__ == "__main__":
    main()
