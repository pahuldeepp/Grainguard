# CLAUDE.md

GreenGuard (GitHub: `pahuldeepp/Grainguard`) rebuilds one agricultural-monitoring platform from the combined patterns of `GrainGuard-` and `CarePulse`, targeting 10M accounts, 10M organizations and 10M concurrent users.

## Always loaded

These files are imported into every session. Keep them short.

@AGENTS.md
@docs/MILESTONES.md
@docs/IMPLEMENTATION_BACKLOG.md
@docs/ARCHITECTURE_REVIEW.md

## Read before you work (not auto-loaded because of size)

Open only the file for the task. [GREENGUARD_MASTER_PLAN.md](GREENGUARD_MASTER_PLAN.md) is about 311 KB: never read it whole. Find the chapter with `grep -n "^## " GREENGUARD_MASTER_PLAN.md` and read that range.

| Task                                                                             | Read                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Any new stage or service                                                         | Master plan chapter 1 (service ownership) and chapter 6 (stages); the service's own `README.md`                                                                          |
| Stage 02–08 code: tenants, devices, ingest, outbox, CDC, Kafka, projections, BFF | [docs/FIRST_VERTICAL_SLICE.md](docs/FIRST_VERTICAL_SLICE.md) — the exact SQL, transaction order, crash matrix and test IDs (D01–D03, I01–I05, E01–E05, P01–P06, Q01–Q04) |
| Contracts, deployment boundaries, operations                                     | [docs/PLATFORM_CONTRACTS_AND_OPERATIONS.md](docs/PLATFORM_CONTRACTS_AND_OPERATIONS.md)                                                                                   |
| Whether a pattern or technology is required, and where it lives                  | [docs/COVERAGE_MATRIX.md](docs/COVERAGE_MATRIX.md) (141 IDs), [docs/TECHNOLOGY_CATALOG.md](docs/TECHNOLOGY_CATALOG.md)                                                   |
| Scale, cells, SLOs, readiness gates G0–G8                                        | [docs/SCALE_AND_PRODUCTION_READINESS.md](docs/SCALE_AND_PRODUCTION_READINESS.md), [docs/CAPACITY_MODEL.md](docs/CAPACITY_MODEL.md)                                       |
| CI, SonarQube, CodeRabbit, Docker staging                                        | [docs/CI_CD.md](docs/CI_CD.md)                                                                                                                                           |
| Local setup                                                                      | [docs/SETUP.md](docs/SETUP.md)                                                                                                                                           |
| Decisions                                                                        | [docs/adr/](docs/adr/) — add a new ADR for any decision that changes an invariant                                                                                        |
| Old-system behaviour to avoid                                                    | `../GRAINGUARD_INVENTORY_AND_PLAN.md`, `../CAREPULSE_INVENTORY_AND_PLAN.md`                                                                                              |

## Before writing any code

1. Find the current stage in `docs/MILESTONES.md` (loaded above). Work on the earliest incomplete stage unless told otherwise.
2. Read that stage's row in `docs/IMPLEMENTATION_BACKLOG.md`: its dependencies must be complete and its acceptance gate is your definition of done.
3. Open the design section for the stage from the table above, and the rows of `docs/ARCHITECTURE_REVIEW.md` it touches.
4. Read the target service's `CLAUDE.md` and `README.md`.
5. State in one or two sentences which documents and invariants the change follows before editing. If the plan is silent or contradicts itself, stop and ask; record the decision as an ADR in `docs/adr/`.

## Implementation order

Build strictly in stage order; do not start a later stage's infrastructure early.

| Stage | Build                                                                                      | Status                   |
| ----- | ------------------------------------------------------------------------------------------ | ------------------------ |
| 01    | Workspace, first three components, Postgres, CI, SonarQube 100% gate                       | Complete                 |
| 02    | Tenant/site/bin/device models, migrations, RLS, PgBouncer, auth, contracts (split 02a/02b) | 02a and 02b done locally |
| 03    | Durable ingest: reading + outbox + receipt + audit in one transaction (split 03a/03b)      | 03a and 03b done locally |
| 04    | Kafka, Schema Registry, Debezium CDC, canonical transformer, DLQ/quarantine                | Planned                  |
| 05    | CQRS read DB, projections, Cassandra history, search, replay                               | Planned                  |
| 06    | Risk scoring, alerts, RabbitMQ jobs, notifications                                         | Planned                  |
| 07    | Sagas (orchestrated, choreographed, TCC), locking, Redis/etcd coordination, mTLS           | Planned                  |
| 08    | Gateway, GraphQL BFF, subscriptions, full dashboard                                        | Planned                  |
| 09–14 | SaaS/billing, remaining profiles, observability, delivery/K8s, capacity, recovery          | Planned                  |

`docs/MILESTONES.md` is the source of truth for status; update this table only when it changes.

## Architecture invariants (never break these)

- One write owner per aggregate and database; services never write another service's tables.
- Every tenant table: `tenant_id` column, forced RLS, composite tenant foreign keys, non-owner runtime role, tenant set with `set_config(..., true)` per transaction.
- A domain change and its event commit together via the outbox; no direct broker publish from request paths.
- Consumers are idempotent through an inbox; offsets commit only after the effect or a confirmed quarantine.
- Event and reading IDs are created once and never regenerated on retry or replay.
- Contended state uses an explicit lock choice (see review P3); document it next to the migration.

## Project subagents

Defined in `.claude/agents/` (list them with `/agents`). Use `architecture-guard` before and after any stage work, `tenant-isolation-reviewer` on anything touching tenant data, and `stage-implementer` to build one backlog stage end to end.

## Commands

```bash
make bootstrap   # install everything
make dev         # local stack, dashboard at http://127.0.0.1:5173
make verify      # format, lint, types, all tests, Go race/vet, build — required before commit
make coverage    # LCOV + Go profile for SonarQube
make smoke       # live-database checks
make sonar-up && make sonar-init && make sonar-scan   # local quality gate
```

Per-service commands are in each service's `CLAUDE.md` or `README.md`.

## Claude-specific rules

- Treat [docs/ARCHITECTURE_REVIEW.md](docs/ARCHITECTURE_REVIEW.md) as open work: when a task touches one of its gaps (P1–P5, R1–R7, O1–O5), close the gap or say why not.
- Coverage gate is 100% with 0 duplication, issues and hotspots. Add tests; never lower the gate or add coverage exclusions to pass.
- Before pushing, run `make coverage && make sonar-scan` locally (after `make sonar-up sonar-init` once). CI's gate also fails on Sonar code-smell rules, which `make verify` does not check. Also type-check from a clean state: generated code (the Prisma client) is not committed.
- Instrument through `@greenguard/otel` (see `docs/adr/0004-tracing.md`): store the live span's `traceparent` on outbox events; never invent trace IDs when tracing is on.
- Keep entry points testable: take config/env/context as parameters (see `services/telemetry-ingest/main.go` `run(ctx, getenv)` and `services/device-service/src/config.ts`).
- Run `coderabbit review` before finishing non-trivial work; treat its findings like a human reviewer's.
- A service folder with only a `README.md` is not implemented. Check for source and tests before assuming a capability exists.
- Update `docs/MILESTONES.md` only with linked evidence under `evidence/`.
