# Real telemetry and outcome dataset intake

See [real data acquisition research](../../docs/intelligence/REAL_DATA_ACQUISITION.md) for the public-source assessment and author-request plan. This is an intake gate for future real-data ML work. No approved sensor + spoilage dataset is present here; real-data training and validation stay blocked until an authorized owner supplies one. Simulator output is not real data or an outcome label.

## Public insect proxy benchmark (separate task)

The Mendeley stored-wheat study is licensed CC BY 4.0 and includes three silos, insect observations, temperature, and grain moisture. It supports only a small **next observed sampling occasion insect-count** research benchmark. It does not contain a spoilage label, and its sample size does not establish commercial-bin generalization. The source workbook uses a `Humidity` column for the grain moisture measurement; the normalizer explicitly maps it to `grain_moisture_percent`, never ambient relative humidity.

Keep the source workbook and normalized CSV outside Git. Install the optional workbook reader in an isolated environment, then run:

```sh
python3 -m venv /tmp/gg-proxy-venv
/tmp/gg-proxy-venv/bin/pip install -r ml/real_data/proxy-requirements.txt
PYTHONPATH=. /tmp/gg-proxy-venv/bin/python -m ml.real_data.normalize_mendeley_insects \
  --xlsx /private/path/Integrated_Modeling_of_Stored-Grain_Insect_Dynamics_and_Infestation_Risk_in_Wheat_Silos.xlsx \
  --output /private/path/stored-wheat-insects.csv
```

Install the repo's pinned intelligence dependencies and evaluate using leave-one-silo-out folds:

```sh
make intelligence-venv
make intelligence-proxy-evaluate PROXY_CSV=/private/path/stored-wheat-insects.csv \
  PROXY_EVIDENCE=/tmp/insect-proxy-evaluation.json
```

The normalizer writes a source sidecar binding the source workbook hash, normalized CSV hash, license, and normalizer hash. The evaluator requires that sidecar. Its evidence is descriptive only and is hard-marked `production_eligible=false` and `promotion_eligible=false`; it cannot be imported to the serving registry. Attribution when sharing derived results must cite the [Mendeley dataset](https://data.mendeley.com/datasets/53ckhtd8gj/1) under its CC BY 4.0 terms.

The evaluation gate is fixed at at least five independent silos and a lower MAE than the training-mean baseline in every held-out silo. This source has only three silos, so the candidate is rejected before registry or deployment. The output is an evaluation receipt; it contains no trained serving artifact.

This proxy experiment is not a substitute for the separate authorized spoilage intake contract below. Do not use it to train or advertise a spoilage, mildew, mycotoxin, or GreenGuard risk model.

Create a private, access-controlled directory outside Git containing `manifest.json`, `telemetry.jsonl`, and `outcomes.jsonl`. Run:

```sh
python3 -m ml.real_data.validate_dataset --root /private/path/dataset
```

The validator checks declared provenance/authorization, file hashes, canonical telemetry shape, adjudicated outcome fields, identity joins, UTC time ranges, duplicates, and leakage-safe entity splits. For each labeled forecast origin it also requires at least one same-lot measurement that was both observed and received by `as_of`, so a future-arriving row cannot masquerade as a usable feature. It emits a dataset digest; it cannot independently prove owner attestations, agronomic correctness, or model accuracy.

Before intake, the data owner must provide written authorization and purpose/retention/access rules; stable pseudonymous site/bin/lot/device mapping; units and calibration provenance; a spoilage definition, observation horizon, adjudication source, censoring and missing-outcome rules; and holdouts by complete sites and/or harvest/weather years. A sensor threshold or simulator label is not spoilage. Remove direct identifiers and never commit raw data, credentials, or customer identifiers. A passing contract check is not permission to promote a model or use predictions in product decisions.
