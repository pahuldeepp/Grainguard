# AGENTS.md

Shared instructions for coding agents (Codex, Claude Code, and others) working in this repository. Claude Code also reads [CLAUDE.md](CLAUDE.md) for tool-specific additions.

## Project

GreenGuard: one agricultural-monitoring platform rebuilt from the combined patterns of `pahuldeepp/GrainGuard-` and `pahuldeepp/CarePulse`, targeting 10M accounts/orgs/concurrent users. Read [README.md](README.md) first, then [GREENGUARD_MASTER_PLAN.md](GREENGUARD_MASTER_PLAN.md) and [docs/MILESTONES.md](docs/MILESTONES.md) for current stage status before making changes. A `services/<name>/README.md` with no source files means that service is scaffolded, not implemented.

## Setup and verification commands

```bash
make bootstrap   # install dependencies across all toolchains
make dev         # run local stack (dashboard: http://127.0.0.1:5173)
make verify      # lint + typecheck + unit tests — required before any commit
make smoke       # live-database smoke tests
make check-plan  # validate planning-doc consistency (not app tests)
```

Check the specific service's README for its own test command before assuming one (Go: `go test ./...`; Node services: see their `package.json`).

## Rules

1. **Tenant isolation is mandatory and layered.** Any tenant-scoped table needs both a Postgres RLS policy and an application-level tenant filter. New tenant-data code paths require a test proving cross-tenant access is denied.
2. **No dual-writes without an outbox or saga.** Writing to two systems (DB + queue, DB + cache) atomically requires a transactional outbox pattern or saga with compensation — never a bare best-effort double write.
3. **Concurrency control must be explicit and documented.** Contended state changes use either optimistic concurrency (version column / `xmin` check) or an explicit pessimistic lock (`SELECT ... FOR UPDATE`) — pick one deliberately per use case and note the choice in the migration or service README.
4. **Milestones require executable evidence.** `docs/MILESTONES.md` only marks a stage complete when linked to test output or CI evidence under `evidence/`. Don't hand-wave completion.
5. **Pin dependencies.** One tested lockfile per toolchain; `make verify` must be green after any dependency change.
6. **Preserve history, don't import old bugs.** Source commit IDs from the original repos are preserved as evidence; implement and test behavior fresh rather than porting known-broken code.

## Layout

```
apps/       web dashboard and mobile
services/   bounded backend contexts (Go, NestJS/TypeScript, Python)
packages/   shared contracts, tenant/auth, telemetry, logging, audit helpers
contracts/  versioned HTTP, GraphQL, Protobuf and event schemas
infra/      Compose, IaC, Kubernetes, GitOps, observability
tests/      unit, contract, integration, e2e, performance, chaos
docs/       blueprint, coverage matrix, backlog, ADRs, runbooks
```

## Before opening a PR / finishing a task

- `make verify` passes.
- New tenant-data paths have a cross-tenant-isolation test.
- Any new dependency is pinned and declared in `docs/TECHNOLOGY_CATALOG.md` if it's a new technology family.
- CI (GitHub Actions + SonarQube quality gate, see [docs/CI_CD.md](docs/CI_CD.md)) is expected to pass — don't disable checks to get green.
- Run `coderabbit review` (CLI already authenticated as `pahuldeepp`) on non-trivial changes before finishing; `.coderabbit.yaml` enforces assertive-profile checks on `services/**` (transaction boundaries, tenant isolation, graceful shutdown) and `.github/workflows/**` (untrusted PR handling, secret exposure, mandatory gates). Treat its request-changes verdicts as blocking, same as a human reviewer.
