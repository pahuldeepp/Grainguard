# Owner authorization: offline I1 simulator and I2 research during GG-04/GG-05 gates

Date: 2026-09-29  
Authority: owner instruction in this chat on 2026-09-29 to continue AI implementation while GG-04 M03 and GG-05 run in parallel. Supplemental owner approval received 2026-09-29: “Authorize synthetic-fixture training only.”

Scope expansion (2026-09-30): the owner explicitly authorized building and validating the grain-physics simulator, bin-level feature corpus, and parity checks, followed by I2 backtesting/model-selection gates. This expands the prior fixture-only scope for offline simulator and synthetic-data work. It does not authorize production predictions or changing product decisions.

Supplemental scope (2026-09-30): the owner also directed completion of the synthetic-only I3–I5 research path, including sequence-model comparisons, local scorer/retraining-candidate and release-controller rehearsals, opt-in deployment packaging, synthetic Risk Engine/Advisor contract acceptance, and isolated disposable Kafka/PostgreSQL crash/failover tests. These are offline/local acceptance exercises; they do not waive the formal GG-04/GG-05 exit gates, authorize shared Compose state, real or tenant data, production model training/registration/promotion, product decision changes, or deployment to a live cluster.

Supplemental implementation note (2026-09-29): the owner directed the next AI/ML step to LightGBM after authorizing synthetic-fixture training only. The initial experiment was limited to one existing fixture run.

Supplemental owner authorization (2026-09-29): the owner approved “Yes, synthetic fixtures only” in response to a request to vary deterministic synthetic seeds and onset times. This permits a fixed-recipe, multi-run evaluation using additional generated synthetic fixture runs for the same threshold-excursion label. Fixture groups must remain disjoint across train/validation/test; parameters must be fixed before validation/test evaluation. The 2026-09-30 scope expansion now also permits a deterministic grain-storage simulator and simulated hotspot labels, but not real or tenant data, deployment, online scoring, risk-engine/alert changes, or user-visible prediction claims.

## Waiver scope

This authorizes **offline, synthetic-only I1–I5 research and local acceptance** while the GG-04/GG-05 exit gates remain incomplete: deterministic sensor fixtures; a bounded, explicitly unvalidated grain-storage simulator; pure feature extraction; bin-level corpus export; offline parity checks against the production ingest validation/normalization code using simulated payloads; I2 backtesting/model selection; I3–I4 sequence-model experiments; and I5 local scorer, retraining-candidate, release-controller, deployment-package, Risk Engine/Advisor contract, and isolated disposable Kafka/PostgreSQL failure acceptance. Simulator and derived labels are research fixtures, not validated spoilage, damage, or agronomic outcomes. This does not authorize real or tenant data, shared Kafka/Compose writes, product decision changes, user-visible prediction claims, production model registration/promotion/deployment, live-cluster rollout, marking GG-04/GG-05/I1–I5/I0 complete, or bypassing any Stage 04/05 evidence requirements.

## Explicit boundaries

- No shared Kafka, CDC, Compose service, or parity-sample ingestion while M03/GG-05 is unresolved. Explicitly isolated disposable synthetic acceptance stacks are allowed for the local tests recorded by this waiver and must clean up their own resources.
- No AWS resources, real tenant data, production auth path, online `ml-scoring`, or production model deployment.
- No ML prediction may change risk-engine decisions, alert creation, notifications, or user-visible risk claims.
- Generated labels and model metrics must be identified as synthetic; they do not prove spoilage prediction or agronomic validity.
- Exploratory fits using 24-hour rolling features and a 48-hour label horizon must be reproducible, time-ordered, and separated by at least a 72-hour purge. Reports must state sample counts, class rates, and that synthetic fixtures cannot establish generalization.
- The advisor/RAG runtime remains unimplemented and behind its I6/I7/I8/I10 gates.
- GG-04 M03 and GG-05 work continues independently; remove this waiver's practical effect once their approved exit gates pass.

This is a scoped owner authorization for offline synthetic I1–I5 research and isolated local acceptance, not a waiver for Stage 04/05 acceptance, production end-to-end integration, release, or production use.
