"""Build isolated synthetic runs and execute the bounded direct-forecast study."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
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
from ml.deep_learning.forecast_experiment import (  # noqa: E402
    START, default_experiment_split, load_forecast_corpora, run_forecast_experiment,
)
from simulate import simulate  # noqa: E402

SYNTHETIC_KEY = b"GreenGuard isolated direct forecast research key 2026"
RUNS = (
    (301, "wet-pocket", 2), (302, "baseline", None), (303, "aeration", None),
    (304, "wet-pocket", 4), (305, "baseline", None), (306, "aeration", None),
    (307, "wet-pocket", 6), (308, "baseline", None), (309, "aeration", None),
)


def _sha(path: Path) -> str:
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(output: Path, *, epochs: int = 8) -> dict:
    output = output.resolve()
    with tempfile.TemporaryDirectory(prefix="greenguard-direct-forecast-") as temporary:
        root = Path(temporary)
        corpus_pairs = []
        inputs = []
        for seed, scenario, wet_start in RUNS:
            sim_dir = root / f"seed-{seed}" / "sim"
            corpus_dir = root / f"seed-{seed}" / "corpus"
            sim_manifest = simulate(sim_dir, scenario=scenario, days=20, seed=seed,
                                   wet_start_day=wet_start)
            corpus_manifest = build_bin_corpus(sim_dir, corpus_dir, secret=SYNTHETIC_KEY)
            corpus_pairs.append((corpus_dir, sim_dir))
            inputs.append({
                "seed": seed, "scenario": scenario,
                "simulator_manifest_sha256": _sha(sim_dir / "manifest.json"),
                "corpus_manifest_sha256": _sha(corpus_dir / "manifest.json"),
                "sequence_rows": corpus_manifest["sequence_rows"],
                "synthetic_only": sim_manifest["synthetic_only"],
            })
        rows = load_forecast_corpora(corpus_pairs)
    report = run_forecast_experiment(rows, default_experiment_split(seed for seed, *_ in RUNS),
                                     epochs=epochs)
    report.update({
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "experiment": "I3/I4 exploratory developing-condition direct multi-horizon forecast",
        "synthetic_runs": inputs,
        "environment": {"python": platform.python_version(), "torch": torch.__version__,
                        "numpy": numpy.__version__, "pyarrow": pyarrow.__version__,
                        "platform": platform.platform(), "machine": platform.machine()},
        "source_sha256": {
            name: _sha(ROOT / path) for name, path in {
                "simulator": "tools/grain-sim/simulate.py",
                "corpus_builder": "ml/corpus/build_bin_corpus.py",
                "sequence_loader": "ml/deep_learning/sequence_models.py",
                "forecast_experiment": "ml/deep_learning/forecast_experiment.py",
                "runner": "ml/deep_learning/run_forecast_synthetic.py",
            }.items()
        },
        "limitations": [
            "deterministic synthetic simulator, not real grain-bin telemetry",
            "temperature and RH are simulator sensor outputs, not spoilage or adverse-condition labels",
            "nine seeds and one simulator design do not represent independent sites or weather years",
            "fixed small architectures and epoch budget are research comparisons, not model selection",
            "not I-stage acceptance, a calibrated forecast, production scoring, or a promotion candidate",
        ],
    })
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=8)
    args = parser.parse_args()
    print(json.dumps(run(args.output, epochs=args.epochs), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
