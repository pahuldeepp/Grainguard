# I4 fair comparison audit — local synthetic research only

The 2026-09-30 local audit preserves the original 18 synthetic runs and the original train/validation/test identities: 216/138/138 examples, six disjoint simulator seeds per cohort. The declared purge is 72 hours (24-hour context plus 48-hour target horizon); the actual selected example gaps are 76 hours at both boundaries. Labels remain the uncalibrated simulator hotspot false-to-true transition target, never spoilage ground truth.

## Implemented checks

- Both sequence and isolated classical adapters now use `ml/deep_learning/comparison_contract.py` for UTC boundaries, the actual context/target horizon, non-overlapping seed cohorts, and selected-sample purge checks.
- One float64 implementation reports Brier, example count, positive rate, and class-degeneracy status for all five models, with no tuned decision threshold.
- [The frozen comparison record](i4-transformer-comparison.frozen-split.json) binds sorted run IDs, exact timestamps, target values, split boundaries, and corpus manifest checksums. Every declared corpus file checksum is verified. Supplied frozen data are checked before training; the classical subprocess verifies the same contract before fitting and returns it for equality checking.
- Duplicate sequence device/time rows are rejected, preventing silent overwrites.
- The runner records source hashes, dependency versions/platform, deterministic CPU settings and model seeds. The artifact includes a stable fingerprint of tensor names, shapes, dtypes, and values.

## Local verification

[17 initial unit/integration checks passed](i4-fair-comparison-tests.log), including all five models on shared purged temporal cohorts, unchanged-data replay, changed expected labels, changed/rehashed corpus bytes rejected before training, duplicate rows, invalid metrics, UTC/horizon/seed isolation, and existing neural architecture checks. The post-review attention-mask suite adds the masked-row regression and passed 18 checks; see [review test evidence](i4-attention-mask-review-tests.log).

```sh
PYTHONPATH=. .local/intelligence-venv/bin/python \
  -m unittest ml.deep_learning.test_sequence_models -v
```

The full fixed eight-epoch I4 experiment was regenerated after the simulator/ingest timestamp correction, then independently regenerated again against the newly written frozen record:

```sh
PYTHONPATH=.:packages/ml-features/src:packages/grain-physics/src \
  .local/intelligence-venv/bin/python -m ml.deep_learning.run_synthetic \
  --include-transformer \
  --frozen-split evidence/intelligence/i4-transformer-comparison.frozen-split.json \
  --output /tmp/greenguard-i4-replay.json
```

[Machine-readable replay evidence](i4-reproducibility-audit.json) records the refreshed report and a second eight-epoch run against the final source. The [final-source replay report](i4-transformer-final-source-replay.json) records current `sequence_models.py` hash `b4318d81…` and matches the refreshed run on all five validation/test metrics, split definitions, labels, inputs, training settings, and Transformer tensor fingerprint. The frozen record is SHA-256 `584f4a60…`. This verifies same-source reproducibility after the event-time correction; it does not establish agronomic forecast validity. The separately retained [attention-mask review evidence](i4-attention-mask-review.json) documents the earlier regression fix and its original benchmark snapshot. The replay artifact has a different serialized byte hash but the same stable tensor fingerprint. Replay can be regenerated using the command above.

| Model | Test Brier, common float64 implementation |
| --- | ---: |
| Logistic Regression | 0.8622909336689512 |
| LightGBM | 0.7101813555968582 |
| LSTM | 0.1619890521484515 |
| TCN | 0.058804805973008675 |
| Transformer | 0.09243162214492325 |

The common float64 calculation slightly changes the neural scores' final digits from the earlier float32 report. Cohort identities, corpus bytes, and training settings remain unchanged. Serialized Transformer `.pt` byte hashes differ across runs because storage identifiers are serialization details; the hash stored in each report verifies that artifact's bytes, while the stable tensor fingerprint proves matching weight values. No byte-identical serialization or cross-platform numerical determinism is claimed.

## Remaining limits

This comparison evaluates existing classical engineered summaries and neural raw sequences on the same labels/data cohorts; it does not isolate architecture quality with identical input representations or guarantee equal tuning effort. The simulator onset schedule intentionally shifts between cohorts and has only three declared scenarios, 18 runs, no independent sites/weather years, and no real tenant telemetry. The task is binary synthetic hotspot classification, not full multi-horizon quantile forecasting or I4 exit acceptance. No model is selected/promoted and no production path is changed.

The refreshed, immutable shadow-only model bundle is `i4-transformer-090b677966f3c9ec`; its version binds its artifact and synthetic training drift reference. No model selection or promotion follows from this synthetic comparison. The classifier is not the designed multi-horizon quantile forecast and remains ineligible for production decisions. CodeRabbit review and broader repository checks belong to the parent integration task; this note establishes only the scoped local evidence above.
