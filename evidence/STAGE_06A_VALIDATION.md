# Stage 06a initial evidence

The deterministic synthetic grain-scoring core was added at `services/risk-engine/scoring.py`. It rejects unsupported, non-finite, out-of-range and non-numeric measurements; missing values cannot create alerts. Its policy carries an explicit version. It does not represent calibrated agronomic advice.

Run from the repository root:

```text
python3 -m unittest discover -s services/risk-engine -v
Ran 5 tests in 0.000s
OK
```

The core selects an explicit grain-type policy and rejects a mismatched policy. Synthetic wheat and canola fixtures produce different scores for the same reading. It does not yet resolve the lot occupying a bin at the reading time.

This is only the first Stage 06a component. There is no running risk consumer, risk database/outbox, alert owner, RabbitMQ worker, provider integration or end-to-end delivery/acknowledgement proof yet. The exit gate remains open per `docs/STAGE_06_PLAN.md`.

`npm test -w @greenguard/contracts` passes 14 tests, including the new strict
`risk.assessed` v1 fixture and rejection of mismatched source causation,
score/severity and alert eligibility. The schema is not yet produced at runtime.
