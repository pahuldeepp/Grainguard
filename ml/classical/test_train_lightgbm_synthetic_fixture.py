from __future__ import annotations

import hashlib
import importlib.util
import json
import math
from pathlib import Path
import secrets
import sys
import tempfile
import unittest

import pyarrow.parquet as pq

REPOSITORY = Path(__file__).resolve().parents[2]
FEATURE_SOURCE = REPOSITORY / "packages" / "ml-features" / "src"
if str(REPOSITORY) not in sys.path:
    sys.path.insert(0, str(REPOSITORY))
if str(FEATURE_SOURCE) not in sys.path:
    sys.path.insert(0, str(FEATURE_SOURCE))

from ml.corpus.build import build_corpus
from ml.classical.train_lightgbm_synthetic_fixture import (
    FEATURES,
    TrainingError,
    _fit_lightgbm,
    _matrix,
    _predict,
    train_fixture,
)
from ml.classical.train_synthetic_fixture import _sha256


def build_test_corpus(root: Path) -> Path:
    generator_path = REPOSITORY / "tools" / "sensor-fixture" / "generate.py"
    spec = importlib.util.spec_from_file_location("greenguard_test_fixture", generator_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load sensor fixture generator")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    fixture_dir = root / "fixture"
    fixture_dir.mkdir()
    generator.generate(fixture_dir, scenario="warming", days=16, seed=17)
    corpus_dir = root / "corpus"
    build_corpus(
        fixture_dir / "readings.jsonl",
        fixture_dir / "labels.jsonl",
        corpus_dir,
        hmac_secret=secrets.token_bytes(32),
    )
    return corpus_dir


class LightGbmSyntheticFixtureTests(unittest.TestCase):
    def test_fit_is_deterministic_and_learns_only_the_synthetic_fixture_signal(self) -> None:
        rows = []
        for index in range(120):
            values = [float(index), *[float(column) for column in range(1, len(FEATURES))]]
            rows.append({"values": values, "label": int(index >= 60)})

        model_a = _fit_lightgbm(rows)
        model_b = _fit_lightgbm(rows)
        self.assertEqual(model_a.model_to_string(), model_b.model_to_string())

        low = {"values": [0.0, *[float(column) for column in range(1, len(FEATURES))]], "label": 0}
        high = {"values": [119.0, *[float(column) for column in range(1, len(FEATURES))]], "label": 1}
        low_probability, high_probability = _predict(model_a, [low, high])
        self.assertTrue(math.isfinite(low_probability))
        self.assertTrue(math.isfinite(high_probability))
        self.assertGreater(high_probability, low_probability)

    def test_matrix_preserves_missing_feature_values_for_lightgbm(self) -> None:
        values = [float("nan"), *[float(column) for column in range(1, len(FEATURES))]]
        matrix, labels = _matrix([{"values": values, "label": 1}])
        self.assertTrue(math.isnan(matrix[0][0]))
        self.assertEqual(labels, [1])

    def test_fit_rejects_single_class_training_data(self) -> None:
        rows = [
            {"values": [float(index)] * len(FEATURES), "label": 1}
            for index in range(20)
        ]
        with self.assertRaisesRegex(TrainingError, "both synthetic label classes"):
            _fit_lightgbm(rows)

    def test_end_to_end_report_binds_deterministic_fixture_sources_and_rejects_tampering(self) -> None:
        with tempfile.TemporaryDirectory(prefix="greenguard-lightgbm-test-") as temporary:
            root = Path(temporary)
            corpus_dir = build_test_corpus(root)
            report_path = root / "report.json"
            report = train_fixture(corpus_dir, report_path)
            self.assertTrue(report["synthetic_only"])
            self.assertFalse(report["promotion_eligible"])
            self.assertEqual(report["metrics"]["test"]["samples"], 24)
            self.assertEqual(report["metrics"]["test"]["positive_rate"], 1.0)
            self.assertEqual(len(report["source_sha256"]["trainer"]), 64)
            self.assertEqual(len(report["source_sha256"]["shared_logistic_trainer"]), 64)
            self.assertEqual(len(report["source_sha256"]["feature_package_init"]), 64)
            self.assertTrue(report["platform"])
            self.assertTrue(report["machine_architecture"])
            self.assertTrue(report_path.is_file())

            manifest_path = corpus_dir / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            feature_path = corpus_dir / "training_rows.parquet"
            table = pq.read_table(feature_path)
            rows = table.to_pylist()
            feature_name = "temperature_c_mean_1h"
            row_to_change = next(row for row in rows if row[feature_name] is not None)
            row_to_change[feature_name] = float(row_to_change[feature_name]) + 1.0
            pq.write_table(table.from_pylist(rows), feature_path, compression="zstd")
            manifest["files"]["training_rows.parquet"]["sha256"] = _sha256(feature_path)
            unhashed = dict(manifest)
            unhashed.pop("dataset_hash", None)
            manifest["dataset_hash"] = hashlib.sha256(
                json.dumps(unhashed, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
            ).hexdigest()
            manifest_path.write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(TrainingError, "feature values differ from regenerated synthetic fixture"):
                train_fixture(corpus_dir, root / "tampered-report.json")


if __name__ == "__main__":
    unittest.main()
