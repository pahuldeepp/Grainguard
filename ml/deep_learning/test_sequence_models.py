from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import torch

from ml.deep_learning.comparison_contract import (
    binary_metrics, naive_prevalence_metrics, verify_frozen_comparison,
)

from ml.deep_learning.sequence_models import (
    CausalConv1d,
    CONTEXT_STEPS,
    INPUT_FEATURES,
    LSTMClassifier,
    MultiHeadAttention,
    Normalizer,
    RunSplit,
    SequenceDataError,
    TARGET,
    TCNClassifier,
    TransformerClassifier,
    ScaledDotProductAttention,
    TemporalSplit,
    sinusoidal_positions,
    _train,
    load_corpora,
    run_experiment,
    split_by_seed,
    split_by_time,
    state_tensor_fingerprint,
)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_run(root: Path, seed: int, label: bool, as_of: datetime | None = None) -> Path:
    directory = root / f"run-{seed}"
    directory.mkdir()
    run_pk = f"run-{seed}"
    as_of = as_of or datetime(2025, 1, 3, tzinfo=timezone.utc)
    mounts = []
    sequences = []
    for index in range(16):
        device = f"device-{index}"
        mounts.append({"device_pk": device, "cable_label": f"c{index // 4 + 1}", "node_index": index % 4 + 1})
        sequences.append({
            "run_pk": run_pk, "as_of": as_of, "device_pk": device,
            "temperature_c": [float(seed + index / 10)] * CONTEXT_STEPS,
            "relative_humidity_percent": [50.0] * CONTEXT_STEPS,
            "missing_mask": [False] * CONTEXT_STEPS,
            "sequence_length": CONTEXT_STEPS, "data_origin": "synthetic_grain_sim", "synthetic_only": True,
        })
    labels = [{"run_pk": run_pk, "as_of": as_of, "label": TARGET, "value": label,
               "data_origin": "synthetic_grain_sim", "label_not_spoilage": True}]
    bin_features = [{"run_pk": run_pk, "as_of": as_of, "data_origin": "synthetic_grain_sim",
                     "label_not_spoilage": True,
                     "temperature_c_mean_1h": float(seed), "temperature_c_mean_24h": float(seed),
                     "temperature_c_delta_1h": 0.1, "temperature_c_delta_24h": 0.2,
                     "relative_humidity_percent_mean_1h": 50.0,
                     "relative_humidity_percent_mean_24h": 50.0,
                     "relative_humidity_percent_delta_1h": 0.1,
                     "relative_humidity_percent_delta_24h": 0.2, "coverage_24h": 1.0}]
    for name, rows in (("sequence_windows.parquet", sequences), ("labels.parquet", labels),
                       ("bin_features.parquet", bin_features),
                       ("mount_context.parquet", mounts)):
        pq.write_table(pa.Table.from_pylist(rows), directory / name)
    file_meta = {name: {"sha256": _sha(directory / name)} for name in
                 ("sequence_windows.parquet", "labels.parquet", "bin_features.parquet", "mount_context.parquet")}
    (directory / "manifest.json").write_text(json.dumps({
        "seed": seed, "run_pk": run_pk, "synthetic_only": True, "label_not_spoilage": True,
        "label_name": TARGET, "split": "unsplit_synthetic_run", "sequence_length": CONTEXT_STEPS,
        "files": file_meta,
    }))
    return directory


class SequenceModelTests(unittest.TestCase):
    def test_temporal_split_purges_context_and_horizon_and_keeps_run_cohorts_disjoint(self) -> None:
        start = datetime(2025, 1, 1, tzinfo=timezone.utc)
        split = TemporalSplit(
            train_end=start + timedelta(days=4),
            validation_start=start + timedelta(days=7, minutes=15),
            validation_end=start + timedelta(days=9),
            test_start=start + timedelta(days=12, minutes=15),
            test_end=start + timedelta(days=14, minutes=15),
            train_seeds=(10,), validation_seeds=(11,), test_seeds=(12,),
        )
        as_ofs = (start + timedelta(days=3, hours=23, minutes=45),
                  start + timedelta(days=7, minutes=15),
                  start + timedelta(days=12, minutes=15),
                  start + timedelta(days=8))
        result = split_by_time(as_ofs, (10, 11, 12, 10), split)
        self.assertEqual(result["train"].tolist(), [0])
        self.assertEqual(result["validation"].tolist(), [1])
        self.assertEqual(result["test"].tolist(), [2])
        with self.assertRaisesRegex(SequenceDataError, "purge"):
            TemporalSplit(
                train_end=start + timedelta(days=4),
                validation_start=start + timedelta(days=6, hours=23),
                validation_end=start + timedelta(days=9),
                test_start=start + timedelta(days=12),
                test_end=start + timedelta(days=14),
            )

    def test_temporal_contract_rejects_utc_horizon_and_seed_leakage(self) -> None:
        start = datetime(2025, 1, 1, tzinfo=timezone.utc)
        bounds = dict(train_end=start, validation_start=start + timedelta(days=4),
                      validation_end=start + timedelta(days=5), test_start=start + timedelta(days=9),
                      test_end=start + timedelta(days=10))
        for extra in ({"context": timedelta(hours=1)}, {"label_horizon": timedelta(hours=1)},
                      {"train_seeds": (1,), "validation_seeds": (1,), "test_seeds": (3,)},
                      {"train_end": start.replace(tzinfo=None)}):
            with self.assertRaises(SequenceDataError):
                TemporalSplit(**(bounds | extra))

    def test_shared_metrics_are_float64_and_reject_invalid_predictions(self) -> None:
        labels = np.asarray([0, 1], dtype=np.float32)
        probabilities = np.asarray([0.1234567, 0.7654321], dtype=np.float32)
        self.assertEqual(binary_metrics(labels, probabilities),
                         binary_metrics(labels.tolist(), probabilities.tolist()))
        for bad in ([float("nan"), 1.0], [-0.1, 0.9], [0.5, 1.1]):
            with self.assertRaises(SequenceDataError):
                binary_metrics(labels, bad)

    def test_duplicate_sequence_rows_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = _write_run(Path(temporary), 10, True)
            path = directory / "sequence_windows.parquet"
            rows = pq.read_table(path).to_pylist()
            pq.write_table(pa.Table.from_pylist(rows + [rows[0]]), path)
            manifest_path = directory / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["files"][path.name]["sha256"] = _sha(path)
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(SequenceDataError, "duplicate sequence"):
                load_corpora([directory])

    def test_split_keeps_seeds_disjoint_and_requires_exact_coverage(self) -> None:
        split = RunSplit((1, 2), (3,), (4,))
        result = split_by_seed([1, 2, 3, 4], split)
        self.assertEqual(result["train"].tolist(), [1, 2])
        with self.assertRaises(SequenceDataError):
            split_by_seed([1, 2, 3], split)
        with self.assertRaises(SequenceDataError):
            split_by_seed([1, 2, 3], RunSplit((1, 2), (2,), (3,)))

    def test_normalizer_fits_only_supplied_training_examples(self) -> None:
        train = np.zeros((2, CONTEXT_STEPS, INPUT_FEATURES), dtype=np.float32)
        validation = np.full((1, CONTEXT_STEPS, INPUT_FEATURES), 999.0, dtype=np.float32)
        scaler = Normalizer.fit(train)
        self.assertTrue(np.all(scaler.mean == 0))
        self.assertGreater(float(np.mean(scaler.transform(validation))), 900)

    def test_models_emit_one_logit_per_sequence_and_train_on_cpu(self) -> None:
        torch.manual_seed(23)
        x = np.random.default_rng(23).normal(size=(4, CONTEXT_STEPS, INPUT_FEATURES)).astype(np.float32)
        y = np.asarray([0, 1, 0, 1], dtype=np.float32)
        for model in (LSTMClassifier(), TCNClassifier()):
            logits = model(torch.from_numpy(x))
            self.assertEqual(tuple(logits.shape), (4,))
            _train(model, x, y, epochs=1, seed=23)
        self.assertTrue(torch.isfinite(model(torch.from_numpy(x))).all())

    def test_transformer_handles_variable_sensor_counts_and_fully_masked_bins(self) -> None:
        model = TransformerClassifier().eval()
        for sensors in (1, 4, 16, 64):
            x = torch.randn(2, CONTEXT_STEPS, sensors * 3)
            x[..., 2::3] = 0.0
            logits, fully_masked = model.forward_with_status(x)
            self.assertEqual(tuple(logits.shape), (2,))
            self.assertFalse(fully_masked.any())
            self.assertTrue(torch.isfinite(logits).all())
        all_missing = torch.zeros((1, CONTEXT_STEPS, 3))
        all_missing[..., 2] = 1.0
        logits, fully_masked = model.forward_with_status(all_missing)
        self.assertTrue(fully_masked.item())
        self.assertEqual(logits.item(), 0.0)

    def test_transformer_attention_matches_torch_reference_masks(self) -> None:
        torch.manual_seed(101)
        attention = ScaledDotProductAttention()
        for dtype, atol in ((torch.float64, 1e-10), (torch.float32, 1e-6)):
            for length, key_length in ((3, 3), (5, 7), (8, 4)):
                q = torch.randn(2, 3, length, 8, dtype=dtype)
                k = torch.randn(2, 3, key_length, 8, dtype=dtype)
                v = torch.randn(2, 3, key_length, 8, dtype=dtype)
                masks = [None,
                         torch.rand((2, 1, 1, key_length)) > 0.3,
                         torch.zeros((1, 1, length, key_length), dtype=dtype)]
                masks[1][:, :, :, 0] = True
                masks[2][..., -1] = float("-inf")
                for mask in masks:
                    for causal in (False, True):
                        actual = attention(q, k, v, mask, is_causal=causal)
                        reference_mask, reference_causal = mask, causal
                        if mask is not None and causal:
                            causal_mask = torch.ones((length, key_length), dtype=torch.bool).tril()
                            if mask.dtype == torch.bool:
                                reference_mask = mask & causal_mask
                            else:
                                reference_mask = mask.masked_fill(~causal_mask, float("-inf"))
                            reference_causal = False
                        expected = torch.nn.functional.scaled_dot_product_attention(
                            q, k, v, attn_mask=reference_mask, is_causal=reference_causal,
                        )
                        torch.testing.assert_close(actual, expected, atol=atol, rtol=atol)

    def test_additive_and_causal_masks_jointly_mask_query_rows(self) -> None:
        for dtype in (torch.float32, torch.float64):
            q = torch.ones(1, 1, 2, 4, dtype=dtype, requires_grad=True)
            k = torch.ones_like(q)
            v = torch.ones_like(q)
            mask = torch.tensor([[[[float("-inf"), 0.0], [float("-inf"), 0.0]]]], dtype=dtype)
            actual = ScaledDotProductAttention()(q, k, v, mask, is_causal=True)
            causal = torch.ones((2, 2), dtype=torch.bool).tril()
            expected = torch.nn.functional.scaled_dot_product_attention(
                q, k, v, attn_mask=mask.masked_fill(~causal, float("-inf")),
            )
            torch.testing.assert_close(actual, expected)
            self.assertTrue(torch.isfinite(actual).all())
            self.assertTrue(torch.equal(actual[0, 0, 0], torch.zeros(4, dtype=dtype)))
            self.assertTrue(torch.equal(actual[0, 0, 1], torch.ones(4, dtype=dtype)))
            actual.sum().backward()
            self.assertTrue(torch.isfinite(q.grad).all())

    def test_transformer_multihead_matches_torch_with_copied_weights(self) -> None:
        torch.manual_seed(55)
        ours = MultiHeadAttention(width=8, heads=2).eval()
        reference = torch.nn.MultiheadAttention(8, 2, batch_first=True, dropout=0.0).eval()
        with torch.no_grad():
            ours.qkv.weight.copy_(reference.in_proj_weight)
            ours.qkv.bias.copy_(reference.in_proj_bias)
            ours.output.weight.copy_(reference.out_proj.weight)
            ours.output.bias.copy_(reference.out_proj.bias)
        x = torch.randn(3, 7, 8)
        actual = ours(x)
        expected = reference(x, x, x, need_weights=False)[0]
        torch.testing.assert_close(actual, expected, atol=1e-6, rtol=1e-6)

    def test_transformer_positional_encoding_matches_closed_form(self) -> None:
        result = sinusoidal_positions(4, 6)
        for position in range(4):
            for index in range(0, 6, 2):
                scale = 10000.0 ** (index / 6)
                self.assertAlmostEqual(result[position, index].item(), np.sin(position / scale), places=6)
                self.assertAlmostEqual(result[position, index + 1].item(), np.cos(position / scale), places=6)

    def test_transformer_trains_and_is_batch_invariant_in_eval(self) -> None:
        torch.manual_seed(31)
        model = TransformerClassifier().eval()
        example = torch.randn(1, CONTEXT_STEPS, INPUT_FEATURES)
        batch = torch.cat((example, torch.randn_like(example)), dim=0)
        alone = model(example)[0]
        together = model(batch)[0]
        torch.testing.assert_close(alone, together, atol=1e-6, rtol=1e-6)
        _train(model, example.numpy(), np.asarray([1.0], dtype=np.float32), epochs=1, seed=31)
        self.assertTrue(torch.isfinite(model(example)).all())

    def test_causal_convolution_prefix_does_not_depend_on_future(self) -> None:
        torch.manual_seed(5)
        conv = CausalConv1d(2, 3, kernel_size=3)
        prefix = torch.tensor([[[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]])
        first = conv(torch.cat((prefix, torch.zeros((1, 2, 3))), dim=-1))
        second = conv(torch.cat((prefix, torch.full((1, 2, 3), 100.0)), dim=-1))
        torch.testing.assert_close(first[:, :, :3], second[:, :, :3])

    def test_parquet_adapter_and_fixed_group_experiment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            corpora = [_write_run(root, seed, seed % 2 == 0) for seed in (10, 11, 12)]
            examples = load_corpora(corpora)
            self.assertEqual(examples.x.shape, (3, CONTEXT_STEPS, INPUT_FEATURES))
            self.assertEqual(set(examples.seeds.tolist()), {10, 11, 12})
            report = run_experiment(corpora, root / "evidence.json",
                                    split=RunSplit((10,), (11,), (12,)), epochs=1, seed=9)
            self.assertEqual(report["seeds"]["test"], [12])
            self.assertFalse(report["training"]["test_used_for_selection"])
            self.assertEqual(set(report["models"]), {"lstm", "tcn"})
            self.assertIn("class_degenerate", report["models"]["lstm"]["validation"])
            self.assertTrue(report["label_not_spoilage"])
            self.assertEqual(report["drift_reference"]["reference_split"], "train")
            self.assertTrue(report["drift_reference"]["synthetic_only"])
            self.assertEqual(report["drift_reference"]["training_split_fingerprint"],
                             report["split_fingerprints"]["train"])
            self.assertEqual(set(report["drift_reference"]["features"]),
                             {"temperature_c", "relative_humidity_percent"})
            i4_report = run_experiment(corpora, root / "i4-evidence.json",
                                       split=RunSplit((10,), (11,), (12,)), epochs=1, seed=9,
                                       include_transformer=True,
                                       export_transformer_artifact=True)
            self.assertIn("transformer", i4_report["models"])
            self.assertEqual(i4_report["stage"], "I4")
            artifact = i4_report["model_artifacts"]["transformer"]
            self.assertFalse(artifact["production_eligible"])
            artifact_path = root / artifact["path"]
            self.assertEqual(artifact["sha256"], _sha(artifact_path))
            state = torch.load(artifact_path, map_location="cpu", weights_only=True)
            self.assertTrue(state)
            self.assertEqual(artifact["state_tensor_sha256"], state_tensor_fingerprint(state))

    def test_frozen_contract_rejects_rehashed_corpus_mutation_before_training(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            corpora = [_write_run(root, seed, seed % 2 == 0) for seed in (10, 11, 12)]
            split = RunSplit((10,), (11,), (12,))
            report = run_experiment(corpora, root / "initial.json", split=split, epochs=1)
            frozen_path = root / report["frozen_comparison"]["path"]
            sequence_path = corpora[-1] / "sequence_windows.parquet"
            rows = pq.read_table(sequence_path).to_pylist()
            rows[0]["temperature_c"][0] += 1.0
            pq.write_table(pa.Table.from_pylist(rows), sequence_path)
            manifest_path = corpora[-1] / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["files"][sequence_path.name]["sha256"] = _sha(sequence_path)
            manifest_path.write_text(json.dumps(manifest))
            with patch("ml.deep_learning.sequence_models._train") as train:
                with self.assertRaisesRegex(SequenceDataError, "frozen comparison differs"):
                    run_experiment(corpora, root / "rejected.json", split=split,
                                   frozen_split=frozen_path, epochs=1)
                train.assert_not_called()

    def test_five_models_share_purged_temporal_frozen_cohorts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            start = datetime(2025, 1, 1, tzinfo=timezone.utc)
            dates = [start + timedelta(days=3), start + timedelta(days=8), start + timedelta(days=13)]
            corpora = [_write_run(root, seed, seed % 2 == 0, dates[(seed - 10) // 2])
                       for seed in range(10, 16)]
            split = TemporalSplit(train_end=start + timedelta(days=4),
                                  validation_start=start + timedelta(days=7, minutes=15),
                                  validation_end=start + timedelta(days=9),
                                  test_start=start + timedelta(days=12, minutes=15),
                                  test_end=start + timedelta(days=14), train_seeds=(10, 11),
                                  validation_seeds=(12, 13), test_seeds=(14, 15))
            report = run_experiment(corpora, root / "temporal.json", split=split, epochs=1,
                                    include_transformer=True, include_classical_baselines=True)
            self.assertEqual(len(report["models"]), 6)
            frozen = json.loads((root / report["frozen_comparison"]["path"]).read_text())
            for name in ("train", "validation", "test"):
                self.assertEqual(len(frozen["selected_rows"][name]), 2)
            for model in report["models"].values():
                self.assertEqual(model["test"]["n"], 2)
                self.assertEqual(model["test"]["positive_rate"], 0.5)
                if "fit_split" not in model:
                    self.assertEqual(set(model["test"]), {"n", "positive_rate", "class_degenerate", "brier"})
            self.assertEqual(report["models"]["naive_train_prevalence"]["fit_split"], "train")
            self.assertEqual(report["models"]["naive_train_prevalence"]["probability"], 0.5)

    def test_same_split_classical_baselines_run_in_isolated_process(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            corpora = [_write_run(root, seed, seed % 2 == 0) for seed in range(10, 16)]
            report = run_experiment(
                corpora, root / "same-split.json",
                split=RunSplit((10, 11), (12, 13), (14, 15)), epochs=1, seed=17,
                include_classical_baselines=True, include_transformer=True,
            )
            self.assertEqual(
                set(report["models"]),
                {"lstm", "tcn", "transformer", "logistic_i2_features", "lightgbm_i2_features",
                 "naive_train_prevalence"},
            )
            frozen_path = root / report["frozen_comparison"]["path"]
            frozen = json.loads(frozen_path.read_text())
            replay = run_experiment(corpora, root / "replay.json",
                                    split=RunSplit((10, 11), (12, 13), (14, 15)), epochs=1, seed=17,
                                    include_classical_baselines=True, include_transformer=True,
                                    frozen_split=frozen_path)
            self.assertEqual(report["models"], replay["models"])
            self.assertEqual(report["label_fingerprints"], replay["label_fingerprints"])
            changed = json.loads(json.dumps(frozen))
            changed["selected_rows"]["test"][0][2] ^= 1
            with self.assertRaises(SequenceDataError):
                verify_frozen_comparison(frozen, changed)
            changed_path = root / "changed.json"
            changed_path.write_text(json.dumps(changed))
            with patch("ml.deep_learning.sequence_models._train") as train:
                with self.assertRaisesRegex(SequenceDataError, "frozen comparison differs"):
                    run_experiment(corpora, root / "rejected.json",
                                   split=RunSplit((10, 11), (12, 13), (14, 15)), frozen_split=changed_path)
                train.assert_not_called()
            self.assertEqual(report["same_split_comparison_status"], "descriptive_metrics_only_no_selection")
        self.assertEqual(report["models"]["lightgbm_i2_features"]["test"]["n"], 2)

    def test_prevalence_baseline_probability_uses_train_only(self) -> None:
        train = np.asarray([0, 0, 1, 0], dtype=np.int64)
        first = naive_prevalence_metrics(train, np.asarray([0, 1, 0]))
        changed_test = naive_prevalence_metrics(train, np.asarray([1, 1, 1]))
        self.assertEqual(first["fit_split"], "train")
        self.assertEqual(first["probability"], 0.25)
        self.assertEqual(changed_test["probability"], first["probability"])
        self.assertNotEqual(changed_test["test"]["brier"], first["test"]["brier"])
        with self.assertRaisesRegex(SequenceDataError, "training labels"):
            naive_prevalence_metrics(np.asarray([], dtype=np.int64), np.asarray([1]))


if __name__ == "__main__":
    unittest.main()
