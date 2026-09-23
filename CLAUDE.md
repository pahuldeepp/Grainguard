# CLAUDE.md

Instructions for Claude Code working in this repository. See [AGENTS.md](AGENTS.md) for the tool-agnostic version shared with Codex and other agents; this file adds Claude-specific notes.

## What this project is

GreenGuard rebuilds one agricultural-monitoring platform from the combined patterns of `pahuldeepp/GrainGuard-` and `pahuldeepp/CarePulse`, targeting 10M accounts/orgs/concurrent users. Start at [README.md](README.md), then [GREENGUARD_MASTER_PLAN.md](GREENGUARD_MASTER_PLAN.md) and [docs/MILESTONES.md](docs/MILESTONES.md) for current stage status. Do not treat scaffolding (a service folder with only a README) as implemented — check for real source and tests before assuming a capability exists.

## Commands

- `make bootstrap` — install dependencies across toolchains
- `make dev` — run the local stack (dashboard at http://127.0.0.1:5173)
- `make verify` — lint, typecheck, unit tests (this is the required check before any commit)
- `make smoke` — live-database smoke tests
- `make check-plan` — validate planning scaffold consistency only; does not run app tests

Per-service commands live in each `services/<name>/README.md` — check there before assuming a generic command works (Go services use `go test ./...`, Node services use their local `package.json` scripts).

## Non-negotiable rules

1. **Tenant isolation.** Every query touching tenant-scoped tables must be provably scoped — via Postgres RLS policy plus an application-layer tenant filter, never RLS alone. Any new endpoint or service that reads/writes tenant data needs a test proving tenant A cannot read/write tenant B's rows.
2. **No orphan dual-writes.** Don't write to two stores (e.g., DB + Kafka, DB + cache) without a transactional outbox or saga compensation step. This bit the source projects before (see `docs/IMPLEMENTATION_BACKLOG.md` failure-mode notes) — don't repeat it.
3. **Concurrency control is explicit.** State that changes under contention (saga steps, billing, device state) needs either optimistic concurrency (a `version`/`xmin` check) or an explicit pessimistic lock (`SELECT ... FOR UPDATE`), chosen deliberately and documented in the migration or service README, not left implicit.
4. **Evidence over assertion.** A milestone is done only when `docs/MILESTONES.md` links executable evidence (tests, CI run, captured output) under `evidence/`. Don't mark a stage complete in docs without it.
5. **One tested lockfile per toolchain.** Don't add a dependency without pinning it in the relevant lockfile and getting `make verify` green.

## Where things live

```
apps/       web dashboard and mobile
services/   bounded backend contexts (Go, NestJS/TypeScript, Python where applicable)
packages/   shared contracts, tenant/auth, telemetry, logging, audit helpers
contracts/  versioned HTTP, GraphQL, Protobuf and event schemas
infra/      Compose, IaC, Kubernetes, GitOps, observability
tests/      unit, contract, integration, e2e, performance, chaos
docs/       blueprint, coverage matrix, backlog, ADRs, runbooks
```

## Working style for this repo

- Prefer extending an existing service/package over creating a new top-level directory; check `docs/TECHNOLOGY_CATALOG.md` and `docs/COVERAGE_MATRIX.md` first — the technology or pattern you need may already have a named home.
- When implementing a milestone from `docs/IMPLEMENTATION_BACKLOG.md`, implement its stated acceptance test, not just the feature.
- CI runs GitHub Actions with a SonarQube quality gate ([docs/CI_CD.md](docs/CI_CD.md)); don't bypass it. If coverage is the blocker, add tests, don't lower the gate.
- Run `coderabbit review` before considering non-trivial work done — it's already authenticated (`pahuldeepp`) and `.coderabbit.yaml` targets tenant isolation and workflow security specifically. Treat its findings as you would a human reviewer's; don't silently dismiss them.
