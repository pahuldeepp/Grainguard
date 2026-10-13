# Synthetic developing-condition forecast research

This isolated I3/I4 research experiment is **synthetic-only and production-ineligible**. It is separate from the existing 48-hour binary hotspot-onset classifier: it directly forecasts simulator bin-mean temperature and relative humidity at 6, 24, and 72 hours, with q10/q50/q90 estimates.

The input is the existing 24-hour, 96-step, 16-sensor sequence export (`[96,48]`: temperature, RH, missing indicator per sensor). Future targets are derived from the simulator's canonical `readings.jsonl` at the exact `as_of + horizon` timestamp. Incomplete future sensor groups are censored; targets are neither interpolated nor forward-filled. Every context timestamp is checked to be strictly before `as_of`, and each target timestamp is checked to be strictly after it.

The experiment creates nine isolated 20-day simulator runs. The train, validation, and test cohorts use three disjoint seeds each, and each cohort is also restricted to chronological ranges separated by at least 96 hours: 24 hours of feature context plus the 72-hour maximum target horizon. Input and target normalizers are fit only on training samples. Validation pinball loss chooses a fixed-architecture checkpoint; the test cohort is used once for final descriptive metrics. Quantile order is enforced by the prediction head.

Models are LSTM, causal TCN, Transformer, last-observation persistence, and a 24-hour seasonal-naive baseline. Reports contain per-horizon/target pinball loss, q50 MAE, q10/q90 coverage, central 80% interval coverage/width, split IDs/times, censor counts, and source/environment fingerprints. Metrics do not select/promote a model.

Run with the already-installed local research environment:

```sh
PYTHONPATH=.:packages/ml-features/src:packages/grain-physics/src \
  .local/intelligence-venv/bin/python -m ml.deep_learning.run_forecast_synthetic \
  --output evidence/intelligence/i3-i4-developing-condition-forecast.json
```

Focused tests:

```sh
PYTHONPATH=. .local/intelligence-venv/bin/python -m unittest \
  ml.deep_learning.test_forecast_experiment -v
```

These outputs are simulator sensor forecasts, not measured grain-state or spoilage forecasts. Nine seeds from one uncalibrated simulator do not represent independent sites, weather years, sensor failures in the future target, or real-world outcomes. This is an exploratory runnable experiment, not formal I-stage acceptance, a deployed scoring path, a promotion candidate, or evidence for product decisions. It does not modify the shared corpus schema, existing sequence classifier, scorer, advisor, or CI.

The current checked-in run uses 147/39/108 train/validation/test windows from disjoint seed groups 301–303, 304–306, and 307–309, with a verified 96-hour purge. On its 108-row synthetic test, train-scale-normalized macro pinball loss was 0.3105 for persistence, 0.3542 for horizon-matched seasonal-naive, 1.5196 for LSTM, 1.8764 for TCN, and 1.4848 for Transformer. These descriptive values show the small neural models did not beat persistence or the seasonal baseline in this run; they are not a model-selection decision. The report stores per-horizon/target native-unit metrics and normalized metrics at `evidence/intelligence/i3-i4-developing-condition-forecast.json`.
