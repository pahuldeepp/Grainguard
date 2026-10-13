# Offline synthetic corpus prototype

Status: **partial offline synthetic foundation only**. `build.py` consumes `tools/sensor-fixture` JSONL and emits the original device-level prototype. The separate `build_bin_corpus.py` consumes `tools/grain-sim` output and emits prototype bin/time features and separate labels. Neither is the complete §3.7 corpus contract or accepted agronomic training dataset. Owner approval covers the uncalibrated offline simulator, synthetic ingest-parser parity, and exploratory I2 work; it does not cover production use. See [`OWNER_WAIVER_I1_OFFLINE.md`](../../evidence/intelligence/OWNER_WAIVER_I1_OFFLINE.md).

The builder emits three separate synthetic-only exports: sampled per-device feature vectors, bounded native-cadence sequence windows, and point-in-time label rows. Feature rows contain no target label fields. The labels describe only the fixture's synthetic temperature/air-RH threshold excursion. They are **not** spoilage, damage, or risk labels. Output carries `data_origin=synthetic` and `split=unsplit_synthetic_fixture`; the single-site fixture cannot support honest train/validation/test generalization splits.

The sequence export defaults to 96 15-minute samples (24 hours) per device with an 8-step (2-hour) stride. Each window ends at the last sample received before `prediction_as_of`; readings delivered after that point are represented as missing, preventing knowledge-time leakage. Each partition is stored under `sequence_windows/tenant=<pseudonym>/month=YYYY-MM/`; labels are similarly partitioned under `labels/`. Window arrays preserve missing samples as nulls with a `missing_mask`, preserve both event and receive timestamps, and set `backfilled=false` because the source fixture has no backfill metadata. Labels remain separate and preserve their exact synthetic point-in-time name/value instead of pretending to be onset intervals.

## Run locally

From the repository root, generate the bounded default fixture and install the one exactly pinned output dependency:

```sh
python3 tools/sensor-fixture/generate.py --output /tmp/gg-fixture --scenario warming --days 4
python3 -m pip install -r ml/corpus/requirements.txt
export PYTHONPATH="packages/ml-features/src${PYTHONPATH:+:$PYTHONPATH}"
export GG_CORPUS_HMAC_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
python3 -m ml.corpus.build \
  --readings /tmp/gg-fixture/readings.jsonl \
  --labels /tmp/gg-fixture/labels.jsonl \
  --output /tmp/gg-corpus \
  --sequence-steps 96 \
  --sequence-stride-steps 8
```

The HMAC secret is supplied only in the environment. The builder derives an opaque dataset ID and a unique per-dataset pseudonymization key from the secret, source/input hashes, feature code versions, and export settings. Rebuilding the same fixture with the same secret and settings produces byte-identical exports; changing the secret changes dataset identity and pseudonyms. Neither derived key nor the supplied secret is written to Parquet or the manifest. Never put the secret in command-line arguments, source control, or the manifest. Input IDs are replaced by 128-bit HMAC-SHA256 pseudonyms before export. The builder rejects duplicate event IDs and labels whose tenant/site/bin identity is absent from the reading fixture, so duplicate deliveries cannot inflate feature values and labels cannot silently attach to an unrelated entity. Exports are assembled in a temporary sibling directory and published by rename only after every Parquet file and the manifest are complete; a failed build leaves no partial dataset at the requested path.

## Authorized exploratory baseline

For the synthetic-only owner waiver, make a longer fixture so temporal validation still has rows after the 72-hour purge (24-hour feature context plus 48-hour label horizon):

```sh
python3 tools/sensor-fixture/generate.py --output /tmp/gg-fixture-ml --scenario warming --days 14
python3 -m pip install -r ml/corpus/requirements.txt
export PYTHONPATH="packages/ml-features/src${PYTHONPATH:+:$PYTHONPATH}"
export GG_CORPUS_HMAC_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
python3 -m ml.corpus.build \
  --readings /tmp/gg-fixture-ml/readings.jsonl \
  --labels /tmp/gg-fixture-ml/labels.jsonl \
  --output /tmp/gg-corpus-ml
python3 -m ml.classical.train_synthetic_fixture \
  --dataset /tmp/gg-corpus-ml \
  --output /tmp/gg-synthetic-baseline.json
```

This fits a deterministic, small logistic baseline to the fixture's **synthetic future sensor-threshold excursion** target, aggregating device features into bin/time examples and using chronological train/validation/test blocks separated by a strict 72-hour purge (24-hour input context plus 48-hour target horizon). The fitter uses only the Python standard library beyond the corpus' pinned PyArrow reader. Its JSON report includes the dataset hash, splits, class rates, Brier scores and limitations. It is not an accepted I2 model, a spoilage prediction, evidence of agronomic validity, or deployable GreenGuard output.

### Exploratory LightGBM comparison

The same owner-authorized synthetic target can also be evaluated with a fixed, deterministic LightGBM GBDT baseline. Install the pinned optional packages with:

```sh
python3 -m pip install -r ml/corpus/requirements.txt -r ml/classical/requirements.txt
```

Then use the same synthetic corpus:

```sh
python3 -m ml.classical.train_lightgbm_synthetic_fixture \
  --dataset /tmp/gg-corpus-ml \
  --output /tmp/gg-lightgbm-synthetic.json
```

The same 72-hour-purged chronological split is shared with the logistic experiment. Before fitting, the LightGBM trainer verifies source hashes, regenerates the declared fixture with the checked-in generator, rebuilds it with the current corpus/feature code, and compares normalized feature/label examples exactly. Parameters and boosting rounds are fixed in code; validation/test results do not tune the model. The report compares held-out Brier scores against both the logistic fit and constant train prevalence, records source hashes, and embeds the synthetic model text. This remains exploratory, may have class-degenerate validation/test blocks, is not for deployment, and must not be interpreted as spoilage or agronomic prediction.

### Multi-run synthetic LightGBM diagnostic

The owner separately approved expanding **synthetic fixtures only** by deterministic seed and onset time. A later 2026-09-30 scope expansion also permits the experimental `tools/grain-sim` simulator, simulated hotspot labels, an offline parity harness against the Go ingest parser/normalizer, and I2 rolling-origin backtesting. It does not authorize real or tenant telemetry, online scoring, product decision changes, user-visible predictions, or deployment. Run the current multi-fixture candidate-selection diagnostic with:

```sh
PYTHONPATH=.:packages/ml-features/src python3 -m ml.classical.train_lightgbm_synthetic_collection \
  --output evidence/intelligence/i1-lightgbm-synthetic-collection.json
```

The script regenerates independent 14-day warming fixtures and keeps each complete run in exactly one split: 8 training, 4 diagnostic validation, and 24 fresh test runs. It selects among 11 predeclared candidates by four-fold grouped cross-validation on training runs only; validation and test runs do not select the candidate. The report records the selected feature set, actual fold count, candidate scores, a per-run Brier comparison, and descriptive bootstrap intervals resampling whole test fixtures rather than correlated hourly rows. Results remain exploratory synthetic evidence, not an I2 gate or a product-quality claim.

Focused trainer checks:

```sh
PYTHONPATH=".:packages/ml-features/src" python3 -m unittest discover -s ml/classical -p 'test_*.py' -v
```

Default sampling is one feature row per device per hour, bounded to 25,000 rows; `--sample-minutes 15` uses the fixture's full 15-minute cadence and remains subject to the same cap. Sequence windows have separate 25,000-row bounds. Inputs are capped at 128 MiB and 100,000 rows each. Parquet is written with Zstandard compression, followed by a manifest containing input/output hashes and explicit limitations. The output directory is local and should be treated as synthetic test material, not production data. `training_rows.parquet` remains device-level prototype output, not the specification's per-bin `bin_features`; this fixture also lacks lot and mount metadata. The manifest limitations must be reviewed before use. It does not satisfy §3.7. The separately gated synthetic baseline does not establish generalization or agronomic validity.

Focused tests:

```sh
PYTHONPATH="packages/ml-features/src${PYTHONPATH:+:$PYTHONPATH}" \
  python3 -m unittest discover -s ml/corpus/tests -v
```

If PyArrow is absent, the CLI fails fast with the pinned install command. `build.py` remains the fixture-only builder and does not produce the full §3.7 layout. The new grain-simulator corpus emits an unsplit single-run bin/time prototype; the separate I2 runner owns its temporal folds. No current corpus proves calibrated physics, weather-year generalization, live Kafka/CDC parity, or any Stage/I1 gate.
