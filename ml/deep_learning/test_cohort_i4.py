from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ml.deep_learning.comparison_contract import SequenceDataError
from ml.deep_learning.run_cohort_i4 import (
    EPOCHS, RUN_SPLIT, TRAINING_SEED, _canonical_json, sha256,
    train_five_model_comparison, validate_catalog,
    validate_split_label_coverage,
)


class CohortI4ProtocolTests(unittest.TestCase):
    def _write_catalog(self, root: Path) -> None:
        runs = []
        for index, seed in enumerate(range(10_000, 10_048)):
            run_id = f"run-{seed}"
            directory = root / f"bin-{index:04d}"
            directory.mkdir()
            names = ("readings.jsonl", "labels.jsonl", "mounts.jsonl", "ambient.jsonl",
                     "lot_context.json", "research_channels.jsonl", "research_labels.jsonl")
            for name in names:
                (directory / name).write_text(f"{name}:{seed}\n")
            files = {name: sha256(directory / name) for name in names[:5]}
            sidecars = {name: sha256(directory / name) for name in names[5:]}
            manifest = {"seed": seed, "run_id": run_id, "simulator_version": "grain-column-exp-0.1.1",
                        "synthetic_only": True, "label_name": "simulated_hotspot_onset_48h",
                        "label_not_spoilage": True, "files": files,
                        "research_extension": {"files": sidecars}}
            manifest_path = directory / "manifest.json"
            manifest_path.write_text(json.dumps(manifest, sort_keys=True))
            runs.append({"cohort_bin": index, "seed": seed, "scenario": ("baseline", "wet-pocket", "aeration")[index % 3],
                         "run_id": run_id, "manifest_sha256": sha256(manifest_path)})
        catalog = {"schema_version": "greenguard-synthetic-research-cohort-v1", "synthetic_only": True,
                   "promotion_eligible": False, "bin_count": 48, "days_per_bin": 14, "runs": runs}
        catalog["cohort_id"] = hashlib.sha256(_canonical_json(catalog)).hexdigest()
        (root / "catalog.json").write_text(json.dumps(catalog, sort_keys=True, indent=2))

    def test_fixed_whole_run_split_covers_all_48_seeds_and_has_both_classes(self) -> None:
        labels = {seed: [0, 1] for seed in range(10_000, 10_048)}
        counts = validate_split_label_coverage(labels)
        self.assertEqual(RUN_SPLIT.train, tuple(range(10_000, 10_030)))
        self.assertEqual(RUN_SPLIT.validation, tuple(range(10_030, 10_039)))
        self.assertEqual(RUN_SPLIT.test, tuple(range(10_039, 10_048)))
        self.assertEqual(counts["train"], {"negative": 30, "positive": 30, "examples": 60})
        self.assertEqual(counts["validation"], {"negative": 9, "positive": 9, "examples": 18})
        self.assertEqual(counts["test"], {"negative": 9, "positive": 9, "examples": 18})

    def test_split_contract_rejects_missing_run_and_degenerate_partition(self) -> None:
        labels = {seed: [0, 1] for seed in range(10_000, 10_048)}
        labels.pop(10_047)
        with self.assertRaisesRegex(SequenceDataError, "exactly cover"):
            validate_split_label_coverage(labels)

        labels = {seed: [0, 1] for seed in range(10_000, 10_048)}
        for seed in RUN_SPLIT.validation:
            labels[seed] = [0, 0]
        with self.assertRaisesRegex(SequenceDataError, "both hotspot classes"):
            validate_split_label_coverage(labels)

    def test_split_contract_rejects_overlapping_seed_assignments(self) -> None:
        labels = {seed: [0, 1] for seed in range(10_000, 10_048)}
        overlap = type(RUN_SPLIT)(RUN_SPLIT.train + (10_030,), RUN_SPLIT.validation,
                                  RUN_SPLIT.test)
        with self.assertRaisesRegex(SequenceDataError, "disjoint"):
            validate_split_label_coverage(labels, overlap)

    def test_catalog_verifies_nested_research_sidecar_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self._write_catalog(root)
            catalog, runs = validate_catalog(root)
            self.assertEqual(catalog["bin_count"], len(runs))
            self.assertEqual(runs[0]["seed"], 10_000)
            # Sidecar hashes are nested under research_extension.files in the
            # simulator manifest, not its canonical top-level files object.
            (root / "bin-0000" / "research_channels.jsonl").write_text("tampered\n")
            with self.assertRaisesRegex(SequenceDataError, "research_channels"):
                validate_catalog(root)

    def test_five_model_runner_requests_exportable_transformer_artifact(self) -> None:
        expected = {"model_artifacts": {"transformer": {"production_eligible": False}}}
        with patch("ml.deep_learning.run_cohort_i4.run_experiment", return_value=expected) as experiment:
            report = train_five_model_comparison([Path("corpus")], Path("report.json"))
        self.assertIs(report, expected)
        experiment.assert_called_once_with(
            [Path("corpus")], Path("report.json"), split=RUN_SPLIT, epochs=EPOCHS,
            seed=TRAINING_SEED, include_classical_baselines=True, include_transformer=True,
            export_transformer_artifact=True,
        )


if __name__ == "__main__":
    unittest.main()
