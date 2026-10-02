# `grain-physics`

Status: bounded I1 physical helpers, not a grain-storage simulator. This
package implements saturation vapour pressure and dew point over liquid water
for 0–50 °C, plus one canola equilibrium moisture relation for 5–25 °C and
0–85% RH. It intentionally rejects sub-zero temperatures until ice-reference
behavior is designed and tested explicitly. It does not yet implement other
crops, respiration, dry-matter loss, heat or moisture transport, or aeration.

The saturation pressure equation uses the corrected liquid-water coefficients
in Appendix 1 of the Buck Research CR-1A User's Manual (revised July 1996).
That appendix says its humidity conversions use the formulations developed by
A. Buck in “New Equations for Computing Vapor Pressure and Enhancement
Factor,” *Journal of Applied Meteorology* 20(12), 1527–1532 (1981). The 1996
manual is available as the [CR-1A User's Manual](https://www.hygrometers.com/wp-content/uploads/CR-1A-users-manual-2009-12.pdf).

Canola equilibrium moisture uses the modified Henderson equation and fitted
constants reported for Tobin rapeseed by S. Sokhansanj, W. Zhijie, D. Jayas,
and T. Kameoka, “Equilibrium Relative Humidity-Moisture Content of Rapeseed
(Canola) from 5 °C to 25 °C,” *Transactions of the ASAE* 29(3), 837–839
(1986), [doi:10.13031/2013.30237](https://doi.org/10.13031/2013.30237).
That paper reports data from 5–25 °C and a fit through 85% RH. The method
returns percent dry basis. Crop variety and adsorption/desorption history can
change the relation; it is a bounded empirical estimate, not measured grain
moisture or a transient model.

Inputs are °C and relative humidity in percent. Pressure is kPa. The inverse
uses bisection over the same equation, avoiding a second approximation.
The 0–50 °C operating range is a conservative package contract for the
current liquid-water equation; it is not a claim that grain-storage
conditions are limited to that range. The functions are not yet connected to
`packages/ml-features`, a grain simulator, or the synthetic fixture.

Run focused tests from the repository root:

```sh
PYTHONPATH=packages/grain-physics/src python3 -m unittest discover \
  -s packages/grain-physics/tests -v
```
