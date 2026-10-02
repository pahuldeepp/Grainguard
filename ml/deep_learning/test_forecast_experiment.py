from __future__ import annotations

from datetime import timedelta
import unittest

import numpy as np
import torch

from ml.deep_learning.forecast_experiment import (
    CONTEXT_STEPS, HORIZONS_HOURS, PURGE_HOURS, START, ForecastDataError,
    ForecastRows, InputNormalizer, LSTMForecaster, TargetNormalizer, TemporalSeedSplit, metrics,
    naive_predictions, ordered_quantiles, targets_after_as_of, temporal_seed_split,
    validate_split,
)


class ForecastExperimentTests(unittest.TestCase):
    def test_targets_are_exact_values_at_all_future_horizons(self):
        as_of = START
        at_6h = as_of + timedelta(hours=6)
        at_24h = as_of + timedelta(hours=24)
        at_72h = as_of + timedelta(hours=72)
        expected = np.asarray(((18.2, 61.4), (20.0, 55.0), (22.4, 49.8)))
        result, counts = targets_after_as_of(as_of, {
            as_of: np.asarray((1.0, 2.0)), at_6h: expected[0], at_24h: expected[1],
            at_72h: expected[2],
        })
        self.assertIsNotNone(result)
        np.testing.assert_array_equal(result, expected)
        self.assertEqual(counts, [16, 16, 16])

    def test_horizon_absence_is_censored_without_interpolation_or_carry_forward(self):
        as_of = START
        at_6h = as_of + timedelta(hours=6)
        result, counts = targets_after_as_of(as_of, {
            at_6h: np.asarray((18.2, 61.4)),
            as_of + timedelta(hours=24): np.asarray((20.0, 55.0)),
            # No 72h observation: do not interpolate or carry forward.
        })
        self.assertIsNone(result)
        self.assertEqual(counts, [16, 16, 0])

    def test_seed_splits_are_disjoint_and_purge_covers_context_plus_target(self):
        split = TemporalSeedSplit(
            train_seeds=(1,), validation_seeds=(2,), test_seeds=(3,),
            train_end=START + timedelta(days=5),
            validation_start=START + timedelta(days=9),
            validation_end=START + timedelta(days=10),
            test_start=START + timedelta(days=14), test_end=START + timedelta(days=17),
        )
        self.assertEqual(PURGE_HOURS, 96)
        validate_split(split, (1, 2, 3))
        with self.assertRaisesRegex(ForecastDataError, "24h context plus 72h"):
            validate_split(TemporalSeedSplit(**{**split.__dict__,
                "validation_start": START + timedelta(days=8)}), (1, 2, 3))

    def test_temporal_seed_split_has_future_holdout_and_exact_purge(self):
        split = TemporalSeedSplit(
            train_seeds=(1,), validation_seeds=(2,), test_seeds=(3,),
            train_end=START + timedelta(days=5),
            validation_start=START + timedelta(days=9), validation_end=START + timedelta(days=10),
            test_start=START + timedelta(days=14), test_end=START + timedelta(days=17),
        )
        times = (START + timedelta(days=4), START + timedelta(days=9), START + timedelta(days=10),
                 START + timedelta(days=14), START + timedelta(days=16))
        rows = ForecastRows(
            x=np.zeros((5, CONTEXT_STEPS, 48), dtype=np.float32),
            y=np.ones((5, 3, 2), dtype=np.float32),
            seeds=np.asarray((1, 2, 2, 3, 3)), run_ids=("a", "b", "b", "c", "c"),
            as_ofs=times, observed_counts=np.full((5, 3), 16),
            censored_candidates={str(h): 0 for h in HORIZONS_HOURS},
        )
        indexes = temporal_seed_split(rows, split)
        self.assertEqual(indexes.train.tolist(), [0])
        self.assertEqual(indexes.validation.tolist(), [1, 2])
        self.assertEqual(indexes.test.tolist(), [3, 4])

    def test_normalizer_is_fit_from_training_only_and_keeps_missing_mask_binary(self):
        train = np.ones((2, CONTEXT_STEPS, 48), dtype=np.float32)
        train[..., 2::3] = 0
        normalizer = InputNormalizer.fit(train)
        test = np.full((1, CONTEXT_STEPS, 48), 99, dtype=np.float32)
        test[..., 2::3] = 1
        transformed = normalizer.transform(test)
        np.testing.assert_array_equal(transformed[..., 2::3], 1)
        self.assertEqual(float(normalizer.mean[0]), 1.0)

    def test_target_inverse_scales_each_horizon_and_target_back_to_units(self):
        mean = np.arange(6, dtype=np.float32).reshape(3, 2)
        scale = np.full((3, 2), 2, dtype=np.float32)
        normalizer = TargetNormalizer(mean, scale)
        normalized = np.ones((4, 3, 2, 3), dtype=np.float32)
        actual = normalizer.inverse(normalized)
        self.assertEqual(actual.shape, (4, 3, 2, 3))
        np.testing.assert_array_equal(actual[0, :, :, 0], mean + scale)
        with self.assertRaisesRegex(ForecastDataError, r"\[N,3,2,3\]"):
            normalizer.inverse(np.zeros((4, 3, 2), dtype=np.float32))

    def test_lstm_quantiles_are_ordered_and_metrics_report_forecast_quality(self):
        model = LSTMForecaster(hidden=4)
        with torch.no_grad():
            output = model(torch.zeros((2, CONTEXT_STEPS, 48)))
        self.assertEqual(tuple(output.shape), (2, 3, 2, 3))
        self.assertTrue(torch.all(output[..., 0] <= output[..., 1]))
        self.assertTrue(torch.all(output[..., 1] <= output[..., 2]))
        actual = np.zeros((2, 3, 2), dtype=np.float64)
        predicted = np.zeros((2, 3, 2, 3), dtype=np.float64)
        report = metrics(actual, predicted)
        self.assertEqual(report["rows"], 2)
        self.assertEqual(report["by_horizon_target"]["24h_temperature_c"]["interval_80_coverage"], 1.0)
        predicted[..., 0] = 1
        with self.assertRaisesRegex(ForecastDataError, "ordering"):
            metrics(actual, predicted)

    def test_naive_baseline_uses_context_and_emits_three_ordered_quantiles(self):
        x = np.zeros((1, CONTEXT_STEPS, 48), dtype=np.float32)
        x[:, -1, 0::3] = 19.0
        x[:, -1, 1::3] = 60.0
        pred = naive_predictions(x, seasonal=False)
        self.assertEqual(pred.shape, (1, 3, 2, 3))
        np.testing.assert_array_equal(pred[0, 0, 0], (19, 19, 19))
        np.testing.assert_array_equal(pred[0, 0, 1], (60, 60, 60))

    def test_seasonal_naive_uses_horizon_specific_previous_day_source_steps(self):
        x = np.zeros((1, CONTEXT_STEPS, 48), dtype=np.float32)
        x[:, :, 2::3] = 0
        x[:, 24, 0::3] = 24
        x[:, 0, 0::3] = 100
        pred = naive_predictions(x, seasonal=True)
        np.testing.assert_array_equal(pred[0, :, 0, 1], (24, 100, 100))

    def test_quantile_ordering_transform_enforces_monotonicity(self):
        raw = torch.randn((4, 18)) * 10
        result = ordered_quantiles(raw)
        self.assertTrue(torch.all(result[..., 0] <= result[..., 1]))
        self.assertTrue(torch.all(result[..., 1] <= result[..., 2]))


if __name__ == "__main__":
    unittest.main()
