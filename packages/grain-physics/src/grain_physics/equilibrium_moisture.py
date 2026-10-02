"""Bounded equilibrium-moisture relationship for canola/rapeseed."""

from __future__ import annotations

import math


def canola_emc_percent_dry_basis(
    temperature_c: float, relative_humidity_percent: float
) -> float:
    """Estimate canola equilibrium moisture content (% dry basis).

    Uses the modified Henderson equation fitted by Sokhansanj et al. (1986):
    ``M = (-ln(1 - RH) / (100**N * A * (T + C)))**(1/N)`` where ``M`` is
    fraction dry basis, ``RH`` is a fraction, ``T`` is °C, and the result is
    converted to percent dry basis. The cited measurements cover 5–25 °C;
    the paper reports fit through 85% RH, so values outside are rejected.

    This is a variety-sensitive empirical equilibrium relation, not a
    prediction of actual grain moisture or a transient drying model.
    """
    for value, field in (
        (temperature_c, "temperature_c"),
        (relative_humidity_percent, "relative_humidity_percent"),
    ):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{field} must be a finite number")
    temperature = float(temperature_c)
    humidity = float(relative_humidity_percent)
    if not 5.0 <= temperature <= 25.0:
        raise ValueError("canola EMC is supported only from 5 to 25 °C")
    if not 0.0 <= humidity <= 85.0:
        raise ValueError("canola EMC is supported only from 0 to 85% RH")
    if humidity == 0:
        return 0.0

    a = 5.056e-4
    c = 40.1204
    n = 1.5702
    rh_fraction = humidity / 100.0
    moisture_fraction_db = (
        -math.log1p(-rh_fraction) / (100.0**n * a * (temperature + c))
    ) ** (1.0 / n)
    return moisture_fraction_db * 100.0
