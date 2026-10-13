# I3/I4 synthetic sequence-model prototypes

This package contains bounded CPU research slices over the I1 `sequence_windows.parquet` export. I3 trains an LSTM and a causal TCN; I4 adds a hand-built patch Transformer. They classify only the simulator's declared 48-hour hotspot target. That label is **not** spoilage ground truth and the simulator is not calibrated to grain-storage outcomes. Each fixture is 14 simulated days with the required two-day label horizon.

The fixed experiment regenerates 18 independent synthetic runs, assigns disjoint six-run cohorts, and evaluates chronologically. Each run emits 14 days of data. Training stops at day 4; validation covers day 7 plus 15 minutes through day 9; test covers day 12 plus 15 minutes through day 14 plus 15 minutes. The split enforces a minimum 72-hour purge between cohorts, covering the full 24-hour input context plus 48-hour target horizon. The actual selected samples are checked for the same gap at runtime. The same run IDs never cross cohorts.

Wet-pocket fixtures stagger onset days across the three periods; baseline and aeration runs supply negative examples. This is controlled synthetic schedule coverage, not independent weather years or real seasonal validation.

Inputs are `[96, 48]`: for each of 16 sensors, temperature, relative humidity, and a missing indicator. Sensor order uses mount cable and node metadata, but mount metadata itself is not a model feature. Feature normalization is fit on training windows only. The fixed I2 logistic and LightGBM baselines use matching `bin_features` rows at the exact same timestamps and seed splits. Architectures and epochs are fixed; validation does not alter model settings, and each model scores the untouched test cohort once.

Run with the isolated pinned experiment dependencies:

```sh
PYTHONPATH=.:packages/ml-features/src:packages/grain-physics/src \
  .local/intelligence-venv/bin/python -m ml.deep_learning.run_synthetic \
  --output evidence/intelligence/i3-synthetic-sequence-baselines.json
```

The I4 comparison uses one shared UTC/72-hour purge validator and one float64 Brier implementation for Logistic Regression, LightGBM, LSTM, TCN, and the Transformer. A `*.frozen-split.json` record binds train/validation/test run IDs, timestamps, labels, boundaries, and verified corpus manifest checksums before training. The classical subprocess verifies that same record before fitting and returns its contract for equality checking. Supplying `--frozen-split` also rejects regenerated corpus or label changes before any model trains. It uses a fixed epoch budget and Brier score, and the test rows are scored only after training choices are fixed:

Latest 138-example synthetic test cohort (lower Brier is better):

| Model | Test Brier |
| --- | ---: |
| TCN | 0.0588 |
| Transformer | 0.0924 |
| LSTM | 0.1620 |
| LightGBM | 0.7102 |
| Logistic Regression | 0.8623 |

This is an intentional onset-time shift across run cohorts, so classical scores are poor and the TCN's apparent advantage may be simulator-specific. It is a warning against choosing from this small synthetic benchmark, not evidence the TCN is a good grain-storage predictor.

```sh
PYTHONPATH=.:packages/ml-features/src:packages/grain-physics/src \
  .local/intelligence-venv/bin/python -m ml.deep_learning.run_synthetic \
  --include-transformer \
  --output evidence/intelligence/i4-transformer-comparison.json
```

To reproduce the frozen I4 data and results with the same pinned CPU environment:

```sh
PYTHONPATH=.:packages/ml-features/src:packages/grain-physics/src \
  .local/intelligence-venv/bin/python -m ml.deep_learning.run_synthetic \
  --include-transformer \
  --frozen-split evidence/intelligence/i4-transformer-comparison.frozen-split.json \
  --output /tmp/greenguard-i4-replay.json
```

The report records source checksums, dependencies/platform, fixed per-model seeds, and a stable fingerprint of the Transformer tensor names, shapes, dtypes, and values. Serialized `.pt` byte hashes remain artifact-integrity checks: serialization storage IDs can differ even when weight values are identical. Reproducibility is demonstrated only in the recorded local environment; it is not a cross-platform numerical guarantee. See [I4 audit evidence](../../evidence/intelligence/I4_FAIR_COMPARISON_AUDIT.md).

The classical models use engineered bin summaries, while the neural models use the raw sequence adapter. This compares the existing feature pipelines on the same labels and rows. It does not isolate architecture performance with identical input representations or establish equal tuning effort; fixed eight-epoch neural training, fixed logistic optimization, and fixed LightGBM rounds are recorded without model selection.

The Transformer patchifies each 24-hour sensor stream with 8-step patches and a 4-step stride, uses context-only per-sensor RevIN-style normalization, custom scaled-dot attention and shared channel-independent encoder weights, then aggregates sensor representations for the bin-level classification task. It handles variable sensor counts and all-missing contexts explicitly.

The experiments are descriptive only. Eighteen synthetic runs do not provide independent sites or weather years; onset dates were intentionally staggered to make each chronological cohort contain both classes. The sample and simulator remain too narrow for generalization claims. The I4 task is hotspot classification, not the design's full multi-horizon quantile forecast acceptance task; same-split classical models are comparisons, not promotion gates. No real telemetry, calibrated physics, validated spoilage labels, I3/I4 acceptance gate, model promotion, online scoring, or product wiring is included. Ambient, lot, and mount metadata are not model input features.

Focused CPU checks:

```sh
PYTHONPATH=. .local/intelligence-venv/bin/python -m unittest ml.deep_learning.test_sequence_models -v
```
