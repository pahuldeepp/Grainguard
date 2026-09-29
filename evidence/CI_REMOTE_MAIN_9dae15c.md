# Remote CI evidence: `main` at 9dae15c

Captured 2026-09-29 with `gh run view` (read-only). This is **new evidence about an existing run**; it does not replace the run's own logs (which expire).

- Run: <https://github.com/pahuldeepp/Grainguard/actions/runs/36308268162> — workflow `CI`, event `push`, branch `main`, commit `9dae15c757e2c1436ee443e86e0e0e4520d6a568`, created 2026-09-27T09:05:35Z.
- Overall conclusion: **failure**, caused by exactly one job that never started (below).

| Job | Conclusion | Relevant to |
|---|---|---|
| Event backbone integration | success | Stage 04 (Kafka, CDC, DLQ, E-series) |
| Search index and Kafka integration | success | Stage 05d |
| Risk, alert, and delivery integration | success | Stage 06 |
| Saga and physical sensor integration | success | Stage 07 |
| Gateway and dashboard end-to-end integration | success | Stage 08 |
| OIDC authentication / OIDC Chromium browser integration | success | Stage 02b/08 |
| Redis cache and failover integration | success | Stage 08 |
| MySQL snapshot and CDC integration | success | Stage 10c |
| Required quality gate (`make verify`, coverage, smoke, Sonar) | success | all |
| Publish verified images | skipped | (not on this trigger) |
| **Cassandra history and fault integration** | **failure — job not started** | Stage 05c |

Annotation on the failed job (verbatim): "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings". This is an account billing condition, not a test result. It says nothing about whether the Cassandra tests pass or fail on CI.

A later run on branch `fix-cassandra-outage-test-shutdown` (run 36337320778, 2026-09-27T17:32Z) had **every** job fail in seconds, consistent with the same billing block at that time; it is not evidence about the code.

## What this does and does not establish

- Stage 04: the *Event backbone integration* job passed remotely on `main`, so "CI has not run remotely" is no longer true for the existing Stage 04 gates. The **bounded recovery relay** and **multi-broker (RF3/minISR2, leader failure)** gates in `docs/STAGE_05_PLAN.md`/`evidence/STAGE_04C_VALIDATION.md` remain open and are not covered by this run.
- Stage 05: five of six 05 sub-gates have remote CI passes or local evidence; the **Cassandra job has no remote result** until billing is resolved and the job is re-run. The 05b production swap procedure and the later unified query router remain open.
