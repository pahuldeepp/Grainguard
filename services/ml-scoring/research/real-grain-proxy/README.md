# USDA grain microclimate proxy evaluation

This is a research-only external-data check for the GreenGuard feature/model
workflow. It uses USDA Agricultural Research Service public-domain experimental
wheat microclimate and progeny data. It does **not** validate commercial-bin
spoilage prediction and it does not produce a deployable GreenGuard model.

The four jar treatments and 20 replicate jars were held in a controlled chamber.
The measurable outcome is day-60 *Sitophilus oryzae* progeny count. The script
uses only early and mid temperature/relative-humidity summaries to predict
whether progeny were observed. Treatment identifiers, late-window observations,
and all outcome-derived fields are excluded from model inputs. The estimate is
leave-one-jar-out and descriptive only: 20 jars from one experiment are not an
independent, representative validation population.

## Run

```sh
.local/ml-scoring-venv/bin/python \
  services/ml-scoring/research/real-grain-proxy/evaluate.py
```

The script downloads the two source CSV files into `.local/research-data/`
(gitignored), verifies their SHA-256 digests against the pinned values in the
script, builds one row per experimental jar, and reports leave-one-jar-out
metrics against a training-fold prevalence baseline. No records are uploaded.

## Sources

- USDA Data.gov catalog: “Data from: Multiple infestation of a grain mass by
  *Sitophilus oryzae* L. and the fungus, *Aspergillus flavus*...”
  <https://catalog.data.gov/dataset/data-from-multiple-infestation-of-a-grain-mass-by-isitophilus-oryzae-i-l-coleoptera-curcul>
- The catalog documents 5-minute temperature/RH sampling over 60 days, five
  jars per treatment, final grain moisture and progeny outcomes; license is
  CC0 1.0.
- This is a controlled laboratory infestation experiment. Progeny is an insect
  reproduction proxy, not a spoilage or mycotoxin label.
