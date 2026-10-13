"""Generate and run the bounded, synthetic-only I3 CPU sequence experiment."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
from importlib.metadata import version as package_version
import json
from pathlib import Path
import platform
import sys
import tempfile

import numpy
import pyarrow
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools" / "grain-sim"))

from ml.corpus.build_bin_corpus import build_bin_corpus  # noqa: E402
from ml.deep_learning.sequence_models import TemporalSplit, run_experiment  # noqa: E402
from simulate import START, simulate  # noqa: E402

RUNS = (
    (100, "wet-pocket", 1), (101, "wet-pocket", 2), (102, "wet-pocket", 3),
    (103, "baseline", None), (104, "aeration", None), (105, "baseline", None),
    (106, "wet-pocket", 6), (107, "wet-pocket", 7), (108, "wet-pocket", 8),
    (109, "baseline", None), (110, "aeration", None), (111, "baseline", None),
    (112, "wet-pocket", 11), (113, "wet-pocket", 12), (114, "wet-pocket", 13),
    (115, "baseline", None), (116, "aeration", None), (117, "baseline", None),
)
SPLIT = TemporalSplit(
    train_end=START + timedelta(days=4),
    validation_start=START + timedelta(days=7, minutes=15),
    validation_end=START + timedelta(days=9),
    test_start=START + timedelta(days=12, minutes=15),
    test_end=START + timedelta(days=14, minutes=15),
    train_seeds=(100, 101, 102, 103, 104, 105),
    validation_seeds=(106, 107, 108, 109, 110, 111),
    test_seeds=(112, 113, 114, 115, 116, 117),
)
# Synthetic IDs only; this key has no privacy/security role and must never be
# reused for a real or tenant dataset.
SYNTHETIC_ONLY_KEY = b"GreenGuard I3 deterministic synthetic pseudonym key 2026"


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(output: Path, *, epochs: int = 8, include_transformer: bool = False, frozen_split: Path | None = None) -> dict:
    output = output.resolve()
    with tempfile.TemporaryDirectory(prefix="greenguard-i3-synthetic-") as temporary:
        temp_root = Path(temporary)
        corpus_dirs = []
        inputs = []
        for seed, scenario, wet_start_day in RUNS:
            run_root = temp_root / f"seed-{seed}"
            sim_dir, corpus_dir = run_root / "sim", run_root / "corpus"
            simulate(sim_dir, scenario=scenario, days=14, seed=seed, wet_start_day=wet_start_day)
            manifest = build_bin_corpus(sim_dir, corpus_dir, secret=SYNTHETIC_ONLY_KEY)
            corpus_dirs.append(corpus_dir)
            inputs.append({
                "seed": seed, "scenario": scenario,
                "simulator_manifest_sha256": _sha(sim_dir / "manifest.json"),
                "corpus_manifest_sha256": _sha(corpus_dir / "manifest.json"),
                "windows": manifest["sequence_rows"],
            })
        report = run_experiment(corpus_dirs, output, split=SPLIT, epochs=epochs,
                                include_classical_baselines=True,
                                include_transformer=include_transformer,
                                export_transformer_artifact=include_transformer, frozen_split=frozen_split)
    report.update({
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "environment": {"python": platform.python_version(), "torch": torch.__version__,
                        "numpy": numpy.__version__, "pyarrow": pyarrow.__version__,
                        "lightgbm": package_version("lightgbm"), "scipy": package_version("scipy"),
                        "narwhals": package_version("narwhals"),
                        "platform": platform.platform(), "machine": platform.machine()},
        "inputs": inputs,
        "source_sha256": {
            "simulator": _sha(ROOT / "tools/grain-sim/simulate.py"),
            "corpus_builder": _sha(ROOT / "ml/corpus/build_bin_corpus.py"),
            "sequence_models": _sha(Path(__file__).with_name("sequence_models.py")),
            "runner": _sha(Path(__file__)),
            "comparison_contract": _sha(Path(__file__).with_name("comparison_contract.py")),
            "classical_baseline_adapter": _sha(Path(__file__).with_name("classical_baselines.py")),
            "i2_logistic_trainer": _sha(ROOT / "ml/classical/train_synthetic_fixture.py"),
            "i2_lightgbm_trainer": _sha(ROOT / "ml/classical/train_lightgbm_synthetic_fixture.py"),
        },
    })
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--include-transformer", action="store_true",
                        help="run the exploratory I4 patch-transformer comparison")
    parser.add_argument("--frozen-split", type=Path, help="verify frozen corpus bytes/IDs/labels before training")
    args = parser.parse_args()
    print(json.dumps(run(args.output, epochs=args.epochs,
                         include_transformer=args.include_transformer, frozen_split=args.frozen_split), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
