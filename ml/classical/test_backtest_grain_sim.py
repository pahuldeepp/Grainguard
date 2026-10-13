from __future__ import annotations

from datetime import timedelta
import unittest

from ml.classical.backtest_grain_sim import (
    FOLD_CUTOFF_HOURS,
    LABEL_HORIZON,
    PURGE_HORIZON,
    SIM_START,
    _folds,
    _paired_run_interval,
)


class GrainSimBacktestTests(unittest.TestCase):
    def test_expanding_windows_purge_feature_context_plus_label_horizon(self) -> None:
        examples = []
        for run in ("run-a", "run-b"):
            for hour in range(24, 240):
                examples.append({
                    "as_of": SIM_START + timedelta(hours=hour),
                    "run_pk": run,
                    "values": [float(hour)],
                    "label": int((hour + (run == "run-b")) % 7 < 3),
                })
        folds = _folds(examples, SIM_START)
        self.assertEqual(len(FOLD_CUTOFF_HOURS), len(folds))
        for fold in folds:
            self.assertLess(
                max(row["as_of"] for row in fold["train"]) + PURGE_HORIZON,
                min(row["as_of"] for row in fold["test"]),
            )
            self.assertEqual(PURGE_HORIZON, timedelta(hours=72))
            self.assertEqual(2, len({row["label"] for row in fold["train"]}))
            self.assertTrue(all(fold["test_start"] <= row["as_of"] < fold["test_end"] for row in fold["test"]))

    def test_refuses_training_window_without_both_label_classes(self) -> None:
        examples = [
            {"as_of": SIM_START + timedelta(hours=hour), "run_pk": "run", "values": [], "label": 0}
            for hour in range(24, 240)
        ]
        with self.assertRaisesRegex(ValueError, "lacks both classes"):
            _folds(examples, SIM_START)

    def test_paired_bootstrap_is_independent_of_pseudonym_order(self) -> None:
        logistic = []
        lightgbm = []
        for run, offset in (("hmac-a", 0.0), ("hmac-b", 0.1), ("hmac-c", -0.1)):
            for label in (0, 1, 0, 1):
                logistic.append({"run_pk": run, "label": label, "prediction": 0.4 + offset})
                lightgbm.append({"run_pk": run, "label": label, "prediction": 0.5})
        original = _paired_run_interval(logistic, lightgbm)
        remapped = {"hmac-a": "key2-z", "hmac-b": "key2-x", "hmac-c": "key2-y"}
        for row in logistic + lightgbm:
            row["run_pk"] = remapped[row["run_pk"]]
        self.assertEqual(original, _paired_run_interval(logistic, lightgbm))


if __name__ == "__main__":
    unittest.main()
