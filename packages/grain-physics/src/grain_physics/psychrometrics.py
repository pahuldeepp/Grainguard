"""Buck (1996) saturation vapour pressure and dew point over liquid water.

This bounded helper is not a complete grain or psychrometric model. It accepts
0..50 °C only, avoiding an unstated water/ice reference change below freezing.
Relative humidity is percent, and pressure is returned in kPa.

The formulation is from Appendix 1 of the CR-1A manual (revised July 1996),
which attributes its vapor-pressure formulation to Buck (1981) and gives the
following corrected liquid-water coefficients.
"""

from __future__ import annotations

import math

_MIN_TEMPERATURE_C = 0.0
_MAX_TEMPERATURE_C = 50.0


def _finite(value: float, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a finite number")
    numeric = float(value)
    if not math.isfinite(numeric):
        raise ValueError(f"{field} must be a finite number")
    return numeric


def _check_temperature(temperature_c: float) -> float:
    temperature = _finite(temperature_c, "temperature_c")
    if not _MIN_TEMPERATURE_C <= temperature <= _MAX_TEMPERATURE_C:
        raise ValueError("temperature_c must be between 0 and 50 °C")
    return temperature


def saturation_vapor_pressure_kpa(temperature_c: float) -> float:
    """Return saturation vapour pressure over water in kPa.

    Uses the revised Buck (1996) equation:
    0.61121 * exp((18.678 - T/234.5) * (T/(257.14 + T))).
    """
    temperature = _check_temperature(temperature_c)
    exponent = (18.678 - temperature / 234.5) * (temperature / (257.14 + temperature))
    return 0.61121 * math.exp(exponent)


def dew_point_c(temperature_c: float, relative_humidity_percent: float) -> float | None:
    """Return dew point in °C, or ``None`` for exactly 0% relative humidity.

    Inverts the same Buck saturation-pressure relation with a bounded
    bisection, so the forward and inverse helpers share one equation.
    """
    temperature = _check_temperature(temperature_c)
    relative_humidity = _finite(relative_humidity_percent, "relative_humidity_percent")
    if not 0 <= relative_humidity <= 100:
        raise ValueError("relative_humidity_percent must be between 0 and 100")
    if relative_humidity == 0:
        return None

    target = saturation_vapor_pressure_kpa(temperature) * relative_humidity / 100
    low, high = _MIN_TEMPERATURE_C, temperature
    if target < saturation_vapor_pressure_kpa(low):
        raise ValueError("dew point is below the supported 0 °C liquid-water range")
    for _ in range(64):
        middle = (low + high) / 2
        if saturation_vapor_pressure_kpa(middle) < target:
            low = middle
        else:
            high = middle
    return (low + high) / 2
