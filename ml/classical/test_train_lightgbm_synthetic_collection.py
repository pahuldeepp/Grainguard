from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from ml.classical.train_lightgbm_synthetic_collection import (
    FIXTURE_SPECS,
    LIGHTGBM_CANDIDATES,
    ORIGINAL_FEATURES,
    _grouped_training_folds,
    evaluate_collection,
)
from ml.classical.train_synthetic_fixture import TrainingError


class LightGbmSyntheticCollectionTests(unittest.TestCase):
    def test_default_holdout_uses_fresh_disjoint_seeded_synthetic_runs(self) -> None:
        groups = {name: set(specs) for name, specs in FIXTURE_SPECS.items()}
        self.assertEqual(len(groups["test"]), 24)
        self.assertEqual({seed for seed, _ in groups["test"]}, set(range(9000, 9024)))
        self.assertFalse(groups["train"] & groups["validation"])
        self.assertFalse(groups["train"] & groups["test"])
        self.assertFalse(groups["validation"] & groups["test"])

    def test_collection_keeps_independent_runs_in_one_split_and_reports_run_level_uncertainty(self) -> None:
        specs = {
            "train": ((17, 0.30), (18, 0.70)),
            "validation": ((27, 0.40), (28, 0.60)),
            "test": ((37, 0.35), (38, 0.65)),
        }
        with tempfile.TemporaryDirectory(prefix="greenguard-lightgbm-collection-test-") as temporary:
            report_path = Path(temporary) / "report.json"
            report = evaluate_collection(report_path, fixture_specs=specs, days=9)
            decoded = json.loads(report_path.read_text(encoding="utf-8"))

        all_runs = [
            record["fixture_run_id"]
            for records in report["fixture_runs"].values()
            for record in records
        ]
        self.assertEqual(len(set(all_runs)), 6)
        self.assertEqual(report["split_run_counts"], {"train": 2, "validation": 2, "test": 2})
        for group_records in report["fixture_runs"].values():
            self.assertTrue(all(record["samples"] > 0 for record in group_records))
        self.assertEqual(report["test_brier_by_run_bootstrap_95_ci"]["runs"], 2)
        paired = report["test_logistic_minus_lightgbm_brier_by_run_bootstrap_95_ci"]
        self.assertEqual(paired["runs"], 2)
        self.assertEqual(paired["resampling_unit"], "independent_fixture_run")
        self.assertEqual(
            paired["mean"],
            sum(row["logistic_brier"] - row["lightgbm_brier"] for row in report["test_per_fixture"]) / 2,
        )
        self.assertIn("paired percentile bootstrap", paired["method"])
        self.assertEqual(
            report["test_brier_by_run_bootstrap_95_ci"]["resampling_unit"],
            "independent_fixture_run",
        )
        self.assertFalse(report["promotion_eligible"])
        self.assertTrue(report["synthetic_only"])
        self.assertEqual(decoded["model_text_sha256"], report["model_text_sha256"])
        selection = report["model_selection"]
        self.assertTrue(selection["train_runs_only"])
        self.assertFalse(selection["validation_used_for_selection"])
        self.assertFalse(selection["test_used_for_selection"])
        self.assertEqual(selection["inner_cv_folds"], 2)
        self.assertEqual(selection["selected_candidate"], report["recipe"]["selection_candidate"])
        self.assertEqual(report["recipe"]["features"], next(
            item["features"] for item in LIGHTGBM_CANDIDATES
            if item["name"] == selection["selected_candidate"]
        ))
        self.assertIn("2 deterministic folds of training runs only", report["recipe"]["selection_policy"])
        selected_candidate = next(
            candidate for candidate in selection["candidates"]
            if candidate["name"] == selection["selected_candidate"]
        )
        trend_selected = any(
            feature not in ORIGINAL_FEATURES for feature in selected_candidate["features"]
        )
        trend_claim = next(
            limitation for limitation in report["limitations"]
            if limitation.startswith("one-hour temperature and humidity trends were evaluated")
        )
        self.assertEqual("were selected by" in trend_claim, trend_selected)
        train_ids = {record["fixture_run_id"] for record in report["fixture_runs"]["train"]}
        validation_ids = {record["fixture_run_id"] for record in report["fixture_runs"]["validation"]}
        test_ids = {record["fixture_run_id"] for record in report["fixture_runs"]["test"]}
        selected_cv_runs = [
            run_id
            for fold in selection["candidates"][0]["folds"]
            for run_id in fold["held_out_fixture_runs"]
        ]
        self.assertCountEqual(selected_cv_runs, train_ids)
        self.assertFalse(set(selected_cv_runs) & validation_ids)
        self.assertFalse(set(selected_cv_runs) & test_ids)
        self.assertTrue(any(candidate["features"] == list(ORIGINAL_FEATURES) for candidate in LIGHTGBM_CANDIDATES))
        self.assertTrue(any(len(candidate["features"]) == 9 for candidate in LIGHTGBM_CANDIDATES))

    def test_inner_folds_keep_complete_fixture_runs_together(self) -> None:
        rows = [
            {"fixture_run_id": run_id, "values": [float(index)], "label": index % 2}
            for run_id in ("a", "b", "c", "d", "e")
            for index in range(4)
        ]
        folds = _grouped_training_folds(rows, max_folds=3)
        held_out = []
        for train_rows, test_rows, held_out_runs in folds:
            train_runs = {row["fixture_run_id"] for row in train_rows}
            test_runs = {row["fixture_run_id"] for row in test_rows}
            self.assertFalse(train_runs & test_runs)
            self.assertEqual(test_runs, set(held_out_runs))
            held_out.extend(test_runs)
        self.assertCountEqual(held_out, ["a", "b", "c", "d", "e"])

    def test_collection_rejects_reusing_a_seed_onset_pair_across_splits(self) -> None:
        specs = {
            "train": ((17, 0.5), (18, 0.6)),
            "validation": ((17, 0.5), (28, 0.4)),
            "test": ((37, 0.3), (38, 0.7)),
        }
        with tempfile.TemporaryDirectory(prefix="greenguard-lightgbm-collection-test-") as temporary:
            with self.assertRaisesRegex(TrainingError, "cannot appear in more than one fixture group"):
                evaluate_collection(Path(temporary) / "report.json", fixture_specs=specs, days=9)

    def test_collection_rejects_reusing_noise_seed_with_a_different_onset(self) -> None:
        specs = {
            "train": ((17, 0.5), (18, 0.6)),
            "validation": ((17, 0.4), (28, 0.5)),
            "test": ((37, 0.3), (38, 0.7)),
        }
        with tempfile.TemporaryDirectory(prefix="greenguard-lightgbm-collection-test-") as temporary:
            with self.assertRaisesRegex(TrainingError, "fixture seeds must be unique"):
                evaluate_collection(Path(temporary) / "report.json", fixture_specs=specs, days=9)

    def test_collection_requires_two_independent_fixture_runs_per_split(self) -> None:
        specs = {
            "train": ((17, 0.5),),
            "validation": ((27, 0.4), (28, 0.6)),
            "test": ((37, 0.3), (38, 0.7)),
        }
        with tempfile.TemporaryDirectory(prefix="greenguard-lightgbm-collection-test-") as temporary:
            with self.assertRaisesRegex(TrainingError, "at least two independent runs"):
                evaluate_collection(Path(temporary) / "report.json", fixture_specs=specs, days=9)


if __name__ == "__main__":
    unittest.main()
