from datetime import datetime, timedelta, timezone
import unittest

from ml_features import TelemetryReading, compute_features


UTC = timezone.utc
AS_OF = datetime(2026, 1, 2, 12, 0, tzinfo=UTC)


def reading(
    event_id: str,
    observed_minutes_ago: int,
    temperature: float | None = 20.0,
    humidity: float | None = 50.0,
    received_minutes_ago: int | None = None,
    *,
    tenant_id: str = "tenant-a",
    device_id: str = "device-1",
) -> TelemetryReading:
    observed = AS_OF - timedelta(minutes=observed_minutes_ago)
    received = AS_OF - timedelta(
        minutes=observed_minutes_ago if received_minutes_ago is None else received_minutes_ago
    )
    return TelemetryReading(
        tenant_id=tenant_id,
        device_id=device_id,
        event_id=event_id,
        observed_at=observed,
        received_at=received,
        measurements={
            "temperature_c": temperature,
            "relative_humidity_percent": humidity,
        },
    )


class KernelTests(unittest.TestCase):
    def test_delivery_order_does_not_change_features(self) -> None:
        rows = [
            reading("r3", 0, 25.0, 60.0),
            reading("r1", 30, 20.0, 50.0),
            reading("r2", 15, 22.0, 55.0),
        ]
        forward = compute_features(rows, as_of=AS_OF)
        shuffled = compute_features([rows[1], rows[2], rows[0]], as_of=AS_OF)
        self.assertEqual(forward, shuffled)
        self.assertEqual(forward.values["temperature_c_delta_1h"], 5.0)
        self.assertEqual(forward.values["reading_count_1h"], 3)

    def test_observed_or_received_after_as_of_cannot_leak(self) -> None:
        known = reading("known", 15, 18.0, 40.0)
        future_observation = reading("future-observed", -5, 99.0, 99.0)
        late_delivery = reading("late", 0, 88.0, 88.0, received_minutes_ago=-1)
        vector = compute_features(
            [known, future_observation, late_delivery], as_of=AS_OF
        )
        self.assertEqual(vector.values["temperature_c"], 18.0)
        self.assertEqual(vector.values["reading_count_24h"], 1)

    def test_missing_values_remain_null_and_are_flagged(self) -> None:
        vector = compute_features(
            [reading("missing", 0, temperature=None, humidity=None)], as_of=AS_OF
        )
        self.assertIsNone(vector.values["temperature_c"])
        self.assertTrue(vector.values["temperature_c_missing"])
        self.assertIsNone(vector.values["relative_humidity_percent"])
        self.assertTrue(vector.values["relative_humidity_percent_missing"])
        self.assertIsNone(vector.values["temperature_c_mean_24h"])

    def test_boolean_measurement_is_rejected(self) -> None:
        invalid = reading("invalid", 0)
        with self.assertRaisesRegex(ValueError, "measurement must be a number"):
            compute_features(
                [TelemetryReading(
                    tenant_id=invalid.tenant_id,
                    device_id=invalid.device_id,
                    event_id=invalid.event_id,
                    observed_at=invalid.observed_at,
                    received_at=invalid.received_at,
                    measurements={"temperature_c": True, "relative_humidity_percent": 50.0},
                )],
                as_of=AS_OF,
            )

    def test_stale_latest_value_exposes_age_when_24h_window_is_empty(self) -> None:
        vector = compute_features(
            [reading("stale", 60 * 30, temperature=17.5, humidity=44.0)],
            as_of=AS_OF,
        )
        self.assertEqual(vector.values["temperature_c"], 17.5)
        self.assertEqual(vector.values["reading_count_24h"], 0)
        self.assertEqual(vector.values["latest_reading_age_minutes"], 1800.0)

    def test_feature_key_is_tenant_scoped_and_mixed_tenants_rejected(self) -> None:
        tenant_a = compute_features([reading("a", 0)], as_of=AS_OF)
        tenant_b = compute_features(
            [reading("b", 0, tenant_id="tenant-b")], as_of=AS_OF
        )
        self.assertEqual(tenant_a.key.entity_id, tenant_b.key.entity_id)
        self.assertNotEqual(tenant_a.key.tenant_id, tenant_b.key.tenant_id)
        with self.assertRaisesRegex(ValueError, "one tenant/device stream"):
            compute_features(
                [reading("a", 0), reading("b", 1, tenant_id="tenant-b")],
                as_of=AS_OF,
            )


if __name__ == "__main__":
    unittest.main()
