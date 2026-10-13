import unittest

from risk_engine.scoring import Policy, assess

SYNTHETIC_WHEAT_POLICY_V1 = Policy("wheat", 1, 25.0, 35.0, 65.0, 80.0, 50, calibrated=True)
SYNTHETIC_CANOLA_POLICY_V1 = Policy("canola", 1, 22.0, 30.0, 60.0, 75.0, 50, calibrated=True)


class ScoringTest(unittest.TestCase):
    def test_boundaries_and_replay(self):
        cases = (
            ({"temperature_c": 24.9, "relative_humidity_percent": 64.9}, 0, "normal", False),
            ({"temperature_c": 25, "relative_humidity_percent": 65}, 50, "warning", True),
            ({"temperature_c": 35, "relative_humidity_percent": 80}, 100, "critical", True),
        )
        for values, score, severity, eligible in cases:
            with self.subTest(values=values):
                first = assess(values, "wheat", SYNTHETIC_WHEAT_POLICY_V1)
                self.assertEqual((first.score, first.severity, first.alert_eligible),
                                 (score, severity, eligible))
                self.assertEqual(first, assess(values, "wheat", SYNTHETIC_WHEAT_POLICY_V1))

    def test_missing_inputs_do_not_generate_alerts(self):
        result = assess({"temperature_c": 40}, "wheat", SYNTHETIC_WHEAT_POLICY_V1)
        self.assertEqual(result.severity, "insufficient_data")
        self.assertIsNone(result.score)
        self.assertFalse(result.alert_eligible)
        self.assertEqual(result.reasons, ("relative_humidity_percent",))

    def test_additive_v2_measurements_are_accepted_without_changing_scoring(self):
        result = assess({"temperature_c": 24, "relative_humidity_percent": 60,
                         "co2_ppm": 410, "grain_moisture_percent": 13.5},
                        "wheat", SYNTHETIC_WHEAT_POLICY_V1)
        self.assertEqual((result.score, result.severity), (0, "normal"))

    def test_invalid_inputs_and_policy_fail_closed(self):
        for value in (float("nan"), float("inf"), True, "40", 121, 10**1000):
            with self.subTest(value=value), self.assertRaises(ValueError):
                assess({"temperature_c": value, "relative_humidity_percent": 90}, "wheat", SYNTHETIC_WHEAT_POLICY_V1)
        with self.assertRaises(ValueError):
            assess({"moisture_percent": 14}, "wheat", SYNTHETIC_WHEAT_POLICY_V1)
        with self.assertRaises(ValueError):
            Policy("wheat", 0, 25, 35, 65, 80, 50)
        with self.assertRaises(ValueError):
            Policy("wheat", 2, 35, 25, 65, 80, 50)
        with self.assertRaises(ValueError):
            Policy("wheat", 2, 25, 35, 65, 80, 76)
        for bad in (("Wheat", 1, 25, 35, 65, 80, 50), ("wheat", 1, float("nan"), 35, 65, 80, 50),
                    ("wheat", 1, 25, 35, 80, 65, 50)):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                Policy(*bad)

    def test_highest_allowed_threshold_keeps_critical_alert_eligible(self):
        policy = Policy("wheat", 2, 25, 35, 65, 80, 75, calibrated=True)
        result = assess({"temperature_c": 35, "relative_humidity_percent": 65}, "wheat", policy)
        self.assertEqual(result.severity, "critical")
        self.assertTrue(result.alert_eligible)

    def test_batch_change_selects_a_different_grain_policy(self):
        values = {"temperature_c": 23, "relative_humidity_percent": 62}
        wheat = assess(values, "wheat", SYNTHETIC_WHEAT_POLICY_V1)
        canola = assess(values, "canola", SYNTHETIC_CANOLA_POLICY_V1)
        self.assertEqual(wheat.score, 0)
        self.assertEqual(canola.score, 50)
        with self.assertRaises(ValueError):
            assess(values, "canola", SYNTHETIC_WHEAT_POLICY_V1)


if __name__ == "__main__":
    unittest.main()
