from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest

from ml.classical.train_synthetic_fixture import (
    FEATURES,
    LABEL_NAME,
    TrainingError,
    _aggregate_examples,
    _fit_logistic,
    _predict,
    _purged_time_splits,
)


class SyntheticFixtureTrainingTests(unittest.TestCase):
    def test_bin_labels_join_only_after_device_features_are_aggregated_at_exact_time(self) -> None:
        timestamp = datetime(2025, 1, 1, tzinfo=timezone.utc)

        def feature(device: str, as_of: datetime, temperature: float, bin_pk: str = "bin-a") -> dict:
            values = {name: 1.0 for name in FEATURES}
            values["temperature_c_mean_1h"] = temperature
            return {
                "tenant_pk": "tenant-a",
                "bin_pk": bin_pk,
                "device_pk": device,
                "as_of": as_of,
                "data_origin": "synthetic",
                "split": "unsplit_synthetic_fixture",
                **values,
            }

        def label(
            as_of: datetime,
            value: bool,
            bin_pk: str = "bin-a",
            tenant_pk: str = "tenant-a",
        ) -> dict:
            return {
                "tenant_pk": tenant_pk,
                "bin_pk": bin_pk,
                "as_of": as_of,
                "label": LABEL_NAME,
                "label_not_spoilage": True,
                "data_origin": "synthetic",
                "split": "unsplit_synthetic_fixture",
                "value": value,
            }

        features = [
            feature("device-1", timestamp, 10.0),
            feature("device-2", timestamp, 30.0),
            feature("device-1", timestamp + timedelta(hours=1), 40.0),
            feature("device-1", timestamp + timedelta(hours=2), 50.0),
            # A feature timestamp with no matching label must not become an example.
            feature("device-1", timestamp + timedelta(hours=3), 999.0),
            # Another tenant may reuse the same bin pseudonym and time without mixing.
            {
                **feature("device-3", timestamp, 90.0),
                "tenant_pk": "tenant-b",
            },
        ]
        labels = [
            label(timestamp, False),
            label(timestamp + timedelta(hours=1), True),
            label(timestamp + timedelta(hours=2), False),
            label(timestamp, True, tenant_pk="tenant-b"),
        ]

        examples = _aggregate_examples(features, labels)

        self.assertEqual(len(examples), 4)
        self.assertEqual([example["label"] for example in examples], [0, 1, 1, 0])
        self.assertEqual(
            examples[0]["values"][FEATURES.index("temperature_c_mean_1h")],
            20.0,
        )
        self.assertEqual(
            examples[1]["values"][FEATURES.index("temperature_c_mean_1h")],
            90.0,
        )

    def test_time_splits_are_ordered_and_purge_feature_context_plus_label_horizon(self) -> None:
        start = datetime(2025, 1, 1, tzinfo=timezone.utc)
        examples = [
            {
                "as_of": start + index * timedelta(hours=1),
                "values": [float(index)] * len(FEATURES),
                "label": index % 2,
            }
            for index in range(24 * 16)
        ]
        splits = _purged_time_splits(examples)
        train_end = splits["train"][-1]["as_of"]
        validation_start = splits["validation"][0]["as_of"]
        validation_end = splits["validation"][-1]["as_of"]
        test_start = splits["test"][0]["as_of"]
        self.assertGreater(validation_start - train_end, timedelta(hours=72))
        self.assertGreater(test_start - validation_end, timedelta(hours=72))
        self.assertLess(splits["train"][-1]["as_of"], splits["validation"][0]["as_of"])
        self.assertLess(splits["validation"][-1]["as_of"], splits["test"][0]["as_of"])

    def test_rejects_too_short_fixture_after_purge(self) -> None:
        start = datetime(2025, 1, 1, tzinfo=timezone.utc)
        examples = [
            {"as_of": start + index * timedelta(hours=1), "values": [], "label": index % 2}
            for index in range(24 * 4)
        ]
        with self.assertRaisesRegex(TrainingError, "too short after the 72-hour feature/label purge"):
            _purged_time_splits(examples)

    def test_logistic_fit_is_deterministic_and_learns_synthetic_signal(self) -> None:
        train = []
        for index in range(100):
            label = int(index >= 50)
            value = float(index)
            train.append({"values": [value] + [float(column) for column in range(1, len(FEATURES))], "label": label})
        model_a = _fit_logistic(train)
        model_b = _fit_logistic(train)
        self.assertEqual(model_a, model_b)
        low = _predict(model_a, [0.0] + [float(column) for column in range(1, len(FEATURES))])
        high = _predict(model_a, [99.0] + [float(column) for column in range(1, len(FEATURES))])
        self.assertGreater(high, low)
        self.assertGreater(high, 0.8)
        self.assertLess(low, 0.2)


if __name__ == "__main__":
    unittest.main()
