"""Run the frozen five-model I4 comparison on the bounded 48-bin cohort.

Only canonical temperature/RH/missing features and the synthetic hotspot-onset
label are consumed. The separate research-channel/exposure-label sidecars use
an incompatible target contract and are intentionally excluded.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import sys
from typing import Any

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "packages" / "ml-features" / "src"))
sys.path.insert(0, str(ROOT / "packages" / "grain-physics" / "src"))

from ml.corpus.build_bin_corpus import build_bin_corpus  # noqa: E402
from ml.deep_learning.comparison_contract import SequenceDataError, naive_prevalence_metrics  # noqa: E402
from ml.deep_learning.sequence_models import RunSplit, TARGET, run_experiment  # noqa: E402

EXPECTED_SEEDS = tuple(range(10_000, 10_048))
RUN_SPLIT = RunSplit(tuple(range(10_000, 10_030)), tuple(range(10_030, 10_039)),
                     tuple(range(10_039, 10_048)))
SEQUENCE_STRIDE_STEPS = 8
TRAINING_SEED = 20261001
EPOCHS = 8
HMAC_KEY = b"GreenGuard synthetic research cohort HMAC key 2026"
RESEARCH_FILES = ("research_channels.jsonl", "research_labels.jsonl")
CANONICAL_FILES = ("readings.jsonl", "labels.jsonl", "mounts.jsonl", "ambient.jsonl", "lot_context.json")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def validate_catalog(cohort_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        catalog_path = cohort_dir / "catalog.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SequenceDataError("cohort catalog is missing or invalid JSON") from exc
    claim = catalog.get("cohort_id")
    unhashed = dict(catalog)
    unhashed.pop("cohort_id", None)
    if not isinstance(claim, str) or hashlib.sha256(_canonical_json(unhashed)).hexdigest() != claim:
        raise SequenceDataError("cohort ID does not match catalog contents")
    runs = catalog.get("runs")
    if (catalog.get("schema_version") != "greenguard-synthetic-research-cohort-v1"
            or catalog.get("synthetic_only") is not True or catalog.get("promotion_eligible") is not False
            or catalog.get("bin_count") != 48 or catalog.get("days_per_bin") != 14
            or not isinstance(runs, list) or len(runs) != len(EXPECTED_SEEDS)):
        raise SequenceDataError("I4 runner requires the bounded 48-run, 14-day synthetic cohort")
    actual = []
    for index, run in enumerate(runs):
        expected_dir = cohort_dir / f"bin-{index:04d}"
        seed = EXPECTED_SEEDS[index]
        if (run.get("cohort_bin") != index or run.get("seed") != seed
                or run.get("run_id") is None or run.get("scenario") not in {"baseline", "wet-pocket", "aeration"}):
            raise SequenceDataError("catalog runs must map each expected seed to exactly one ordered bin")
        manifest_path = expected_dir / "manifest.json"
        if not expected_dir.is_dir() or sha256(manifest_path) != run.get("manifest_sha256"):
            raise SequenceDataError(f"simulator manifest does not match catalog for seed {seed}")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (manifest.get("seed") != seed or manifest.get("run_id") != run["run_id"]
                or manifest.get("synthetic_only") is not True
                or manifest.get("label_name") != TARGET or manifest.get("label_not_spoilage") is not True):
            raise SequenceDataError(f"canonical hotspot simulator contract mismatch for seed {seed}")
        expected_files = dict(manifest.get("files", {}))
        expected_files.update(manifest.get("research_extension", {}).get("files", {}))
        for name in (*CANONICAL_FILES, *RESEARCH_FILES):
            path = expected_dir / name
            expected_hash = expected_files.get(name)
            if not path.is_file() or not isinstance(expected_hash, str) or sha256(path) != expected_hash:
                raise SequenceDataError(f"input checksum mismatch for seed {seed}: {name}")
        actual.append({"seed": seed, "scenario": run["scenario"], "directory": expected_dir,
                       "manifest": manifest, "manifest_sha256": sha256(manifest_path)})
    if set(EXPECTED_SEEDS) != set(RUN_SPLIT.train + RUN_SPLIT.validation + RUN_SPLIT.test):
        raise SequenceDataError("fixed split does not cover the cohort")
    return catalog, actual


def validate_split_label_coverage(labels_by_seed: dict[int, list[int]], split: RunSplit = RUN_SPLIT) -> dict[str, dict[str, int]]:
    """Require exact whole-run seed coverage and both classes before training."""
    groups = {"train": split.train, "validation": split.validation, "test": split.test}
    all_ids = [seed for seeds in groups.values() for seed in seeds]
    if len(all_ids) != len(set(all_ids)) or set(all_ids) != set(labels_by_seed):
        raise SequenceDataError("split seeds must be disjoint and exactly cover the cohort labels")
    counts: dict[str, dict[str, int]] = {}
    for name, seeds in groups.items():
        values = [label for seed in seeds for label in labels_by_seed[seed]]
        if not values or any(label not in (0, 1) for label in values):
            raise SequenceDataError(f"{name} labels must be a non-empty binary vector")
        negatives = sum(label == 0 for label in values)
        positives = sum(label == 1 for label in values)
        if not negatives or not positives:
            raise SequenceDataError(f"{name} split must contain both hotspot classes before training")
        counts[name] = {"negative": negatives, "positive": positives, "examples": len(values)}
    return counts


def _labels_for_windows(corpus_dir: Path, seed: int) -> list[int]:
    manifest = json.loads((corpus_dir / "manifest.json").read_text(encoding="utf-8"))
    if (manifest.get("seed") != seed or manifest.get("label_name") != TARGET
            or manifest.get("synthetic_only") is not True or manifest.get("label_not_spoilage") is not True
            or manifest.get("sequence_stride_steps") != SEQUENCE_STRIDE_STEPS):
        raise SequenceDataError(f"canonical corpus contract or stride mismatch for seed {seed}")
    for name in ("sequence_windows.parquet", "labels.parquet", "bin_features.parquet", "mount_context.parquet"):
        path = corpus_dir / name
        if manifest.get("files", {}).get(name, {}).get("sha256") != sha256(path):
            raise SequenceDataError(f"corpus checksum mismatch for seed {seed}: {name}")
    sequence_times = set(pq.read_table(corpus_dir / "sequence_windows.parquet", columns=["as_of"])
                         .column("as_of").to_pylist())
    labels: dict[Any, int] = {}
    for row in pq.read_table(corpus_dir / "labels.parquet").to_pylist():
        if (row.get("label") != TARGET or row.get("data_origin") != "synthetic_grain_sim"
                or row.get("label_not_spoilage") is not True or not isinstance(row.get("value"), bool)):
            raise SequenceDataError(f"unsupported label in canonical corpus for seed {seed}")
        if row["as_of"] in labels:
            raise SequenceDataError(f"duplicate canonical label timestamp for seed {seed}")
        labels[row["as_of"]] = int(row["value"])
    if not sequence_times or not sequence_times.issubset(labels):
        raise SequenceDataError(f"canonical labels and sequence windows differ for seed {seed}")
    return [labels[at] for at in sorted(sequence_times)]


def prepare_corpora(cohort_dir: Path, corpus_root: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[Path]]:
    catalog, inputs = validate_catalog(cohort_dir)
    corpus_root.mkdir(parents=True, exist_ok=True)
    corpora = []
    for item in inputs:
        seed = item["seed"]
        destination = corpus_root / f"seed-{seed}"
        if destination.exists():
            if not destination.is_dir() or not (destination / "manifest.json").is_file():
                raise SequenceDataError(f"corpus destination is partial or invalid for seed {seed}")
            corpus_manifest = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))
            if (corpus_manifest.get("source_manifest_sha256") != item["manifest_sha256"]
                    or not isinstance(corpus_manifest.get("run_pk"), str)
                    or len(corpus_manifest["run_pk"]) != 32):
                raise SequenceDataError(f"cached corpus was built from different input for seed {seed}")
        else:
            build_bin_corpus(item["directory"], destination, secret=HMAC_KEY,
                             sequence_stride_steps=SEQUENCE_STRIDE_STEPS)
        item["corpus_dir"] = destination
        item["corpus_manifest"] = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))
        item["window_labels"] = _labels_for_windows(destination, seed)
        corpora.append(destination)
    return catalog, inputs, corpora


def train_five_model_comparison(corpora: list[Path], output: Path) -> dict[str, Any]:
    """Run fixed I4 models and export Transformer weights for shadow bundling."""
    return run_experiment(corpora, output, split=RUN_SPLIT, epochs=EPOCHS, seed=TRAINING_SEED,
                         include_classical_baselines=True, include_transformer=True,
                         export_transformer_artifact=True)


def run(cohort_dir: Path, corpus_root: Path, output: Path) -> dict[str, Any]:
    catalog, inputs, corpora = prepare_corpora(cohort_dir.resolve(), corpus_root.resolve())
    labels_by_seed = {item["seed"]: item["window_labels"] for item in inputs}
    label_counts = validate_split_label_coverage(labels_by_seed)
    train_labels = np.asarray([value for seed in RUN_SPLIT.train for value in labels_by_seed[seed]], dtype=np.int64)
    test_labels = np.asarray([value for seed in RUN_SPLIT.test for value in labels_by_seed[seed]], dtype=np.int64)

    report = train_five_model_comparison(corpora, output)
    baseline = naive_prevalence_metrics(train_labels, test_labels)
    if baseline["test"]["n"] != report["examples"]["test"]:
        raise SequenceDataError("preflight baseline and model test rows differ")
    report["models"]["naive_train_prevalence"] = baseline
    report["metrics"]["naive_baseline"] = (
        "constant positive prevalence measured from training labels only, evaluated on the same frozen test rows")

    report.update({
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "production_eligible": False,
        "cohort_protocol": {
            "cohort_id": catalog["cohort_id"], "catalog_sha256": sha256(cohort_dir / "catalog.json"),
            "input_manifest_sha256": {str(item["seed"]): item["manifest_sha256"] for item in inputs},
            "canonical_input_sha256": {
                str(item["seed"]): {name: sha256(item["directory"] / name) for name in CANONICAL_FILES}
                for item in inputs
            },
            "corpus_manifest_sha256": {str(item["seed"]): sha256(item["corpus_dir"] / "manifest.json")
                                        for item in inputs},
            "corpus_file_sha256": {str(item["seed"]): item["corpus_manifest"]["files"] for item in inputs},
            "corpus_counts": {str(item["seed"]): {
                "bin_feature_rows": item["corpus_manifest"]["rows"],
                "label_rows": pq.read_metadata(item["corpus_dir"] / "labels.parquet").num_rows,
                "sequence_sensor_rows": item["corpus_manifest"]["sequence_rows"],
                "unique_sequence_examples": len(item["window_labels"]),
            }
                              for item in inputs},
            "split_seeds": {"train": list(RUN_SPLIT.train), "validation": list(RUN_SPLIT.validation),
                            "test": list(RUN_SPLIT.test)},
            "split_label_counts": label_counts,
            "sequence_stride_steps": SEQUENCE_STRIDE_STEPS,
            "hmac_key_material": "fixed local synthetic-only key; value not recorded; not a secret or tenant key",
            "research_sidecars": {
                "excluded": list(RESEARCH_FILES),
                "sha256": {str(item["seed"]): {name: sha256(item["directory"] / name)
                                                 for name in RESEARCH_FILES} for item in inputs},
                "reason": "their cumulative exposure label and added gas/moisture features do not match the existing hotspot scorer contract",
            },
            "fixed_training": {"models": ["logistic_i2_features", "lightgbm_i2_features", "lstm", "tcn", "transformer"],
                               "epochs": EPOCHS, "seed": TRAINING_SEED, "device": "cpu",
                               "test_used_for_selection": False},
        },
        "limitations": list(report.get("limitations", [])) + [
            "The 48-bin extension is a single generated cohort, not independent real sites or weather years.",
            "The separate research_channels/research_labels sidecars were excluded; models use only canonical T/RH/missing inputs and the simulated hotspot-onset label.",
            "This comparison does not validate spoilage, does not authorize model selection or promotion, and remains production-ineligible.",
        ],
        "runtime_environment": {"python": platform.python_version(), "platform": platform.platform()},
    })
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cohort", type=Path, default=Path("/tmp/gg-grain-research-cohort"))
    parser.add_argument("--corpus-root", type=Path, default=Path("/tmp/gg-grain-research-i4-corpora"))
    parser.add_argument("--output", type=Path, default=Path("evidence/intelligence/i4-research-cohort-comparison.json"))
    args = parser.parse_args()
    try:
        report = run(args.cohort, args.corpus_root, args.output)
    except (OSError, ValueError, KeyError) as exc:
        print(json.dumps({"status": "rejected", "error": str(exc)}), file=sys.stderr)
        return 2
    print(json.dumps({"status": "complete", "output": str(args.output),
                      "cohort_id": report["cohort_protocol"]["cohort_id"],
                      "examples": report["examples"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
