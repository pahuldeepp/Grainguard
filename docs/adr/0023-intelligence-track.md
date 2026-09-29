# ADR-0023: Parallel GreenGuard Intelligence track

Status: Accepted (owner, 2026-09-29) · Date: 2026-09-28

## Context

`CLAUDE.md` requires building strictly in stage order and not starting a later stage's infrastructure early. Stages 09–14 are planned. The AI work (GreenGuard Intelligence, `docs/intelligence/`) depends mainly on canonical events (04, in progress: bounded recovery relay, multi-broker evidence and remote CI open), read models and history (05, in progress), risk and alerts (06, complete locally, CI pending), identity (02b, complete) and the BFF/dashboard (08, complete locally, CI pending), with specific later dependencies on 09 (token exchange, entitlements), 10 (feature flags, OpenSearch) and 12–13 (delivery, load). Waiting for Stage 14 would delay all AI work by months, but the track must still wait for each real dependency's exit gate.

## Decision

1. Add a parallel **Intelligence track** with stages I0–I13 (I8 split into I8a/I8b/I8c), defined in `docs/intelligence/README.md` §5 with its dependency table. As of 2026-09-29 only I0 (documents and ADRs) may proceed; implementation stages wait for GG-04/05 exit gates.
2. **Order.** The numbered stages 01–14 stay strictly ordered. Within the track, order is a dependency graph: an I-stage starts only when every dependency listed in `docs/intelligence/README.md` §5 meets its exit gate. There is no other exception — in particular no stage (including I6) starts early; as of 2026-09-29 only I0 may proceed.
   **"Meets its exit gate"** means the dependency's evidence is linked in `docs/MILESTONES.md` **and** a green remote CI run exists for it. If a dependency is complete locally with CI pending, the I-stage may start only after CI is green or an owner-signed waiver is recorded in that I-stage's evidence naming the risk. Stage 10 evidence counts for I5/I7 only for the specific sub-stage listed in §5 (10a OpenSearch for I7; 10b flags for I5) and only to the extent its own milestone row says it passed.
   **ADR prerequisites:** ADR-0025 (backfill, amends ADR-0006) must be Accepted before I1 code starts; ADR-0026 (delegated identity) before I6/I8a. The duplicate ADR-0018 numbering and the gaps at 0012/0016 pre-date this track.
3. I-stages follow every existing invariant and completion rule: evidence under `evidence/`, `docs/MILESTONES.md` updated only with linked evidence, two-tenant isolation tests, coverage gate, `make verify`, CodeRabbit.
4. Where an I-stage needs something a planned GreenGuard stage owns (Stage 09 token exchange and entitlements, Stage 11 collector, Stage 12 Helm/GitOps/Terraform, Stage 13 load tooling), the I-stage either waits for it or builds the minimum shared piece in that stage's location with that stage's owner rules, recorded in the I-stage evidence. It never forks a parallel implementation.
5. `docs/MILESTONES.md` gains an Intelligence table; `CLAUDE.md`, `AGENTS.md` and `docs/IMPLEMENTATION_BACKLOG.md` gain a pointer to this ADR.
6. **Exposure gate.** No LLM-facing or ML-advisory feature is exposed beyond the local/dev stack until I10's red-team and approval gates and I12's dashboards and alerts pass.
7. **Core-service changes.** The track changes existing services only through `docs/intelligence/README.md` §4 (each change assigned to a stage with an exit test and the owning stage's rules). Where the minimum shared piece of a later stage is needed (e.g. an Argo manifest for model deployment, Stage 12), decision 4's rule applies and a waiver is recorded.
8. **Authority.** `risk-engine` remains the alert authority; ML output is advisory only (README R7). Runtime flags may override model cohorts in seconds; Git is the record and is reconciled to the flags within 15 minutes (README R10).
9. **Quality gates.** Every new service is added to the Sonar sources and the coverage script in the stage that creates it (CLAUDE.md coverage rules unchanged).

## Consequences

AI design work (I0) starts now; implementation stages start only when their dependencies, including GG-04 and GG-05, pass their gates (decision 2). Risk: I-stages may discover gaps in unfinished stages (e.g. Stage 09 token exchange); these become explicit dependencies, not workarounds. Capacity claims remain bound to Stage 13/I13 measured evidence.
