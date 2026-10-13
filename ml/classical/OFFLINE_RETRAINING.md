# Offline synthetic candidate retraining

From the repository root, using the existing pinned intelligence environment:

```bash
.local/intelligence-venv/bin/python -m ml.classical.retrain_synthetic_candidate \
  --output-root evidence/intelligence/offline-candidates
.local/intelligence-venv/bin/python -m unittest ml.classical.test_retrain_synthetic_candidate -v
```

The command generates only the checked-in I2 grain simulator seeds 10–17 and
their declared scenarios, builds temporary synthetic corpora, then fits the
fixed logistic and LightGBM recipes in four expanding temporal folds. Each
fold has a 72-hour purge (24-hour feature context plus 48-hour label horizon)
and reports Brier score, log loss,
accuracy, and the training-prevalence baseline. The command accepts no input
dataset path, tenant key, seed override, or database connection.

The output is an immutable directory named by the SHA-256 of its canonical
manifest before adding the candidate ID. It contains eight fitted model
artifacts, `evaluation.json`, and `manifest.json`. The manifest hashes each
model artifact and evaluation file. The evaluation records source hashes,
simulator/corpus manifest hashes, split row hashes, fixed recipes, and runtime
versions. Repeating the run with the same sources and runtime reproduces the
directory ID and bytes. An existing identical directory is reused; changed,
missing, extra, or symlinked files are refused. No wall-clock timestamp or
output path enters the hashed content.

`--promote` and `--champion` always fail, including values such as `false`,
`off`, or `none`. The Python API also refuses any non-`None` value for those
settings. This command has no registry or serving integration. It compares
fixed candidates descriptively and selects no winner. Fold-specific artifacts
retain the model evaluated in that fold; the command does not refit on the
evaluation windows.

The local I5 retraining rehearsal was run on 2026-09-30: the fixed recipe
generated candidate `f14e2aacca3df72fd2071bf65457ab720714632f4c55496d8fd8c83299a9a247`
(6,912 synthetic rows, four temporal folds), then a fresh local-synthetic
release controller accepted its receipt as `verified_offline`. The controller
remained in `shadow`, selected no candidate, and its temporary state was
deleted. The report and candidate hashes are in
`evidence/intelligence/i5-offline-retraining-acceptance.json`.

**Synthetic labels cannot qualify a production model.** These are
uncalibrated simulator hotspot-transition labels, not observed spoilage or
agronomic outcomes. The folds share training history and provide no untouched
outer holdout. Real-world validity, production readiness, I2/I5 acceptance,
scheduled or production retraining, and cross-platform bitwise identity are
not established by this command.
