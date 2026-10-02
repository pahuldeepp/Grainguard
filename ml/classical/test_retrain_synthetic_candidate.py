from __future__ import annotations

from datetime import timedelta
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from ml.classical import retrain_synthetic_candidate as candidate


class SyntheticCandidateTests(unittest.TestCase):
    def test_promotion_and_champion_settings_are_refused_before_input_generation(self) -> None:
        with patch.object(candidate, "_generated_examples") as generate:
            for name in ("promote", "champion"):
                for value in (True, False, "false", "off", "", {}, 0):
                    with self.subTest(name=name, value=value):
                        with self.assertRaisesRegex(ValueError, "refuse every promotion or champion"):
                            candidate.run(Path("unused"), **{name: value})
            generate.assert_not_called()

    def test_cli_refuses_promotion_champion_and_external_input(self) -> None:
        for arguments in (("--promote",), ("--promote=false",),
                          ("--champion=none",), ("--input-dir=/tenant/data",),
                          ("--seed=123",)):
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    [sys.executable, "-m", "ml.classical.retrain_synthetic_candidate", *arguments],
                    cwd=candidate.ROOT, capture_output=True, text=True, check=False,
                )
                self.assertEqual(2, result.returncode)
                self.assertIn("error:", result.stderr)

    def test_generation_uses_only_fixed_seed_recipe_and_synthetic_key(self) -> None:
        def fake_simulate(path: Path, **kwargs: object) -> None:
            path.mkdir(parents=True)
            (path / "manifest.json").write_text(json.dumps(kwargs, sort_keys=True))

        def fake_build(source: Path, target: Path, **kwargs: object) -> dict:
            target.mkdir(parents=True)
            (target / "manifest.json").write_text('{"synthetic_only":true}')
            return {"dataset_id": "fixture-id"}

        with tempfile.TemporaryDirectory() as temporary, \
                patch.dict(os.environ, {"GG_CORPUS_HMAC_KEY": "real-tenant-key-must-not-be-read"}), \
                patch.object(candidate, "simulate", side_effect=fake_simulate) as simulator, \
                patch.object(candidate, "build_bin_corpus", side_effect=fake_build) as builder, \
                patch.object(candidate, "_load_run", return_value=({}, [{"fixture": True}])):
            rows, inputs = candidate._generated_examples(Path(temporary))
        self.assertEqual(len(candidate.RUN_SPECS), len(rows))
        self.assertEqual(list(candidate.RUN_SPECS), [(item["seed"], item["scenario"]) for item in inputs])
        self.assertEqual(len(candidate.RUN_SPECS), simulator.call_count)
        self.assertTrue(all(call.kwargs["days"] == 10 for call in simulator.call_args_list))
        self.assertTrue(all(call.kwargs["secret"] == candidate.SYNTHETIC_ONLY_KEY
                            for call in builder.call_args_list))

    def test_rebuilt_models_and_metrics_are_deterministic_and_temporally_purged(self) -> None:
        rows = [
            {"as_of": candidate.SIM_START + timedelta(hours=hour), "run_pk": run,
             "values": [float(hour % 11 + column + run_index)
                        for column in range(len(candidate.FEATURES))],
             "label": int((hour // 3 + run_index) % 3 == 0)}
            for run_index, run in enumerate(("synthetic-a", "synthetic-b"))
            for hour in range(24, 240, 3)
        ]
        first_folds, first_models = candidate._evaluate(rows)
        second_folds, second_models = candidate._evaluate(rows)
        self.assertEqual(first_folds, second_folds)
        self.assertEqual(first_models, second_models)
        self.assertEqual(8, len(first_models))
        for fold in first_folds:
            latest = candidate.SIM_START.fromisoformat(fold["train_latest"])
            earliest = candidate.SIM_START.fromisoformat(fold["test_earliest"])
            self.assertLess(latest + timedelta(hours=48), earliest)
            self.assertEqual({"logistic", "lightgbm"}, set(fold["metrics"]))
            for metrics in fold["metrics"].values():
                self.assertEqual(fold["test_rows"], metrics["samples"])
                self.assertGreaterEqual(metrics["brier_score"], 0)
                self.assertIn("constant_train_prevalence_brier", metrics)

    def test_identical_packages_replay_across_output_roots_with_verified_file_hashes(self) -> None:
        report = {"synthetic_only": True, "production_eligible": False,
                  "promotion_eligible": False, "selected_model": None, "champion": None}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = candidate._write_package(root / "a", report, {"model.json": b"synthetic"})
            replay = candidate._write_package(root / "a", report, {"model.json": b"synthetic"})
            second = candidate._write_package(root / "b", report, {"model.json": b"synthetic"})
            self.assertEqual(first, replay)
            self.assertEqual(first.name, second.name)
            manifest = json.loads((first / "manifest.json").read_bytes())
            self.assertEqual(manifest, candidate.verify_package(first))
            self.assertFalse(manifest["production_eligible"])
            self.assertFalse(manifest["promotion_eligible"])
            self.assertIsNone(manifest["champion"])
            self.assertIsNone(manifest["selected_model"])
            for name, expected in manifest["files"].items():
                data = (first / name).read_bytes()
                self.assertEqual(expected["sha256"], hashlib.sha256(data).hexdigest())
                self.assertEqual(data, (second / name).read_bytes())

    def test_candidate_artifact_paths_and_reserved_names_are_rejected(self) -> None:
        for name in ("../escape", "subdir/model", r"subdir\\model", "manifest.json", "evaluation.json"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaisesRegex(ValueError, "safe, reserved-free filenames"):
                    candidate._write_package(Path(temporary), {}, {name: b"artifact"})

    def test_package_verifier_rejects_rewritten_manifest_and_payload(self) -> None:
        report = {"synthetic_only": True, "production_eligible": False,
                  "promotion_eligible": False, "selected_model": None, "champion": None}
        for mutation in ("payload", "eligibility"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                package = candidate._write_package(Path(temporary), report, {"model.json": b"artifact"})
                if mutation == "payload":
                    (package / "model.json").write_bytes(b"tampered")
                else:
                    manifest = json.loads((package / "manifest.json").read_bytes())
                    manifest["promotion_eligible"] = True
                    (package / "manifest.json").write_bytes(candidate._canonical(manifest))
                with self.assertRaises(ValueError):
                    candidate.verify_package(package)

    def test_package_verifier_rejects_recomputed_promotion_claims(self) -> None:
        report = {"synthetic_only": True, "production_eligible": False,
                  "promotion_eligible": False, "selected_model": None, "champion": None}
        with tempfile.TemporaryDirectory() as temporary:
            package = candidate._write_package(Path(temporary), report, {"model.json": b"artifact"})
            manifest_path = package / "manifest.json"
            manifest = json.loads(manifest_path.read_bytes())
            manifest["promotion_eligible"] = True
            manifest.pop("candidate_id")
            new_id = candidate._sha(candidate._canonical(manifest))
            manifest["candidate_id"] = new_id
            manifest_path.write_bytes(candidate._canonical(manifest))
            package = package.rename(package.parent / new_id)
            with self.assertRaisesRegex(ValueError, "non-promotion claims"):
                candidate.verify_package(package)

    def test_package_verifier_rejects_non_integer_artifact_sizes(self) -> None:
        report = {"synthetic_only": True, "production_eligible": False,
                  "promotion_eligible": False, "selected_model": None, "champion": None}
        with tempfile.TemporaryDirectory() as temporary:
            package = candidate._write_package(Path(temporary), report, {"model.json": b"artifact"})
            manifest_path = package / "manifest.json"
            manifest = json.loads(manifest_path.read_bytes())
            manifest["files"]["model.json"]["bytes"] = float(
                manifest["files"]["model.json"]["bytes"]
            )
            manifest.pop("candidate_id")
            new_id = candidate._sha(candidate._canonical(manifest))
            manifest["candidate_id"] = new_id
            manifest_path.write_bytes(candidate._canonical(manifest))
            package = package.rename(package.parent / new_id)
            with self.assertRaisesRegex(ValueError, "artifact hash or size"):
                candidate.verify_package(package)

    def test_existing_candidate_tampering_is_refused_without_overwrite(self) -> None:
        for modification in ("changed", "missing", "extra", "symlink"):
            with self.subTest(modification=modification), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                report, models = {"synthetic_only": True}, {"model.json": b"original"}
                package = candidate._write_package(root, report, models)
                model = package / "model.json"
                if modification == "changed":
                    model.write_bytes(b"tampered")
                elif modification == "extra":
                    (package / "unexpected.txt").write_bytes(b"extra")
                elif modification == "missing":
                    model.unlink()
                else:
                    model.unlink()
                    (root / "external.json").write_bytes(b"original")
                    model.symlink_to(root / "external.json")
                with self.assertRaisesRegex(ValueError, "immutable candidate package has been modified"):
                    candidate._write_package(root, report, models)
                if modification == "changed":
                    self.assertEqual(b"tampered", model.read_bytes())

    def test_content_changes_create_a_different_candidate_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = candidate._write_package(root, {"metric": 0.1}, {"model.json": b"a"})
            new_model = candidate._write_package(root, {"metric": 0.1}, {"model.json": b"b"})
            new_metric = candidate._write_package(root, {"metric": 0.2}, {"model.json": b"a"})
            self.assertEqual(3, len({first.name, new_model.name, new_metric.name}))

    def test_nonfinite_json_is_refused_and_missing_features_hash_as_null(self) -> None:
        with self.assertRaises(ValueError):
            candidate._canonical({"metric": float("nan")})
        row = {"as_of": candidate.SIM_START, "run_pk": "synthetic", "label": 0,
               "values": [float("nan")]}
        self.assertEqual(64, len(candidate._rows_sha([row])))


if __name__ == "__main__":
    unittest.main()
