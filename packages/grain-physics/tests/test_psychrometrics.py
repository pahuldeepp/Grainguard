from __future__ import annotations

import math
import unittest

from grain_physics import (
    canola_emc_percent_dry_basis,
    dew_point_c,
    saturation_vapor_pressure_kpa,
)


class PsychrometricsTests(unittest.TestCase):
    def test_buck_saturation_pressure_reference_point(self) -> None:
        self.assertAlmostEqual(saturation_vapor_pressure_kpa(20.0), 2.3383, places=3)

    def test_dew_point_round_trips_vapor_pressure(self) -> None:
        dew_point = dew_point_c(20.0, 50.0)
        self.assertIsNotNone(dew_point)
        assert dew_point is not None
        expected_vapor_pressure = saturation_vapor_pressure_kpa(20.0) * 0.5
        self.assertAlmostEqual(
            saturation_vapor_pressure_kpa(dew_point), expected_vapor_pressure, places=10
        )

    def test_saturated_air_has_dew_point_equal_to_air_temperature(self) -> None:
        self.assertAlmostEqual(dew_point_c(20.0, 100.0) or 0.0, 20.0, places=10)

    def test_zero_humidity_has_no_finite_dew_point(self) -> None:
        self.assertIsNone(dew_point_c(20.0, 0.0))

    def test_rejects_dew_points_below_supported_range(self) -> None:
        for temperature, humidity in ((20.0, 10.0), (0.0, 50.0)):
            with self.subTest(temperature=temperature, humidity=humidity):
                with self.assertRaisesRegex(ValueError, "below the supported 0 °C"):
                    dew_point_c(temperature, humidity)

    def test_rejects_out_of_domain_or_non_finite_inputs(self) -> None:
        for invalid in (-0.1, 50.1, math.nan, math.inf, True):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                saturation_vapor_pressure_kpa(invalid)
        for invalid in (-0.1, 100.1, math.nan, True):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                dew_point_c(20.0, invalid)

    def test_canola_emc_is_monotonic_and_uses_dry_basis_percent(self) -> None:
        at_50_rh = canola_emc_percent_dry_basis(5.0, 50.0)
        self.assertAlmostEqual(at_50_rh, 8.79, delta=0.02)
        self.assertGreater(canola_emc_percent_dry_basis(5.0, 70.0), at_50_rh)
        self.assertGreater(canola_emc_percent_dry_basis(5.0, 85.0), at_50_rh)
        self.assertLess(canola_emc_percent_dry_basis(25.0, 50.0), at_50_rh)
        self.assertEqual(canola_emc_percent_dry_basis(5.0, 0.0), 0.0)

    def test_canola_emc_rejects_out_of_published_range(self) -> None:
        invalid_pairs = ((4.99, 50.0), (25.01, 50.0), (10.0, 85.01), (10.0, -0.01))
        for temperature, humidity in invalid_pairs:
            with self.subTest(temperature=temperature, humidity=humidity):
                with self.assertRaises(ValueError):
                    canola_emc_percent_dry_basis(temperature, humidity)


if __name__ == "__main__":
    unittest.main()
