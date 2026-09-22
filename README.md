# GreenGuard — rebuild from first principles

One agricultural monitoring platform that brings together the technologies, architectural patterns, tools, and lessons from **pahuldeepp/GrainGuard-** and **pahuldeepp/CarePulse**.

Design target: **10 million accounts, 10 million organizations and 10 million concurrent active users**, with [explicit capacity assumptions and production-readiness gates](docs/SCALE_AND_PRODUCTION_READINESS.md).

**Status: Stage 01 local foundation implemented and verified; GitHub CI and SonarQube now configured; strict coverage gate currently failing.** React, NestJS, Go and PostgreSQL form the initial runnable setup. See [setup instructions](docs/SETUP.md) and the [milestone tracker](docs/MILESTONES.md). The original repositories are preserved beside this directory, with full available Git mirrors and separate GitHub exports. This project starts clean; the archived source is evidence, not an implicit production baseline.

Start with [the single complete architecture plan](GREENGUARD_MASTER_PLAN.md), or [the shorter rebuild blueprint](docs/REBUILD_BLUEPRINT.md), then [the coverage matrix](docs/COVERAGE_MATRIX.md). Use [the technology catalog](docs/TECHNOLOGY_CATALOG.md) for the declared dependencies, container images, GitHub Actions, and infrastructure resources found across the source histories. [The implementation backlog](docs/IMPLEMENTATION_BACKLOG.md) orders the work from basics to full operation.

The source audits are [GrainGuard](../GRAINGUARD_INVENTORY_AND_PLAN.md) and [CarePulse](../CAREPULSE_INVENTORY_AND_PLAN.md). They distinguish source code, runtime wiring, test evidence, scaffolds, and blueprint-only ideas. The archive entry point is [ARCHIVE_AND_REBUILD.md](../ARCHIVE_AND_REBUILD.md).

The user's ten capability bullets are [adapted for both the existing projects and this new rebuild](../GRAINGUARD_CAREPULSE_PROJECT_BULLETS.md), with measured achievements kept separate from performance and quality targets.

## Delivery and code quality

[CI/CD setup, SonarQube and CodeRabbit](docs/CI_CD.md) documents the pipeline, local quality server, Docker staging, release gates and current coverage gap. Repository: https://github.com/pahuldeepp/Grainguard.

## Start locally

From this folder, run `make bootstrap`, then `make dev`. Open http://127.0.0.1:5173. Use `make verify` for code checks and `make smoke` for live database tests. See [setup instructions](docs/SETUP.md) for prerequisites and shutdown.

## Layout

```text
apps/                     web dashboard and mobile application
services/                 bounded backend contexts; see individual READMEs
packages/                 contracts, tenant/auth, telemetry, logging, audit helpers
contracts/                versioned HTTP, GraphQL, Protobuf and event contracts
infra/                    Compose profiles, IaC, Kubernetes, GitOps, observability
tests/                    unit, contract, integration, end-to-end, performance, chaos
labs/                     explicit comparison / interoperability profiles
docs/                     blueprint, coverage, backlog, ADRs, operations
scripts/                  reproducibility and evidence checks
```

## Working agreement

1. Every technology and pattern remains discoverable in the catalog, coverage matrix, or source audit. Historical versions remain evidence; new services get one tested lockfile per supported toolchain.
2. Start with Stage 01 and a single tenant/site/device flow. Add distributed-system components in dependency order.
3. Every stage requires executable acceptance evidence. A folder, dependency, green badge, or README assertion does not prove a capability works.
4. The full-stack target includes all families from both projects. Conflicting providers and domain-specific integrations receive named profiles or adapters rather than silently disappearing.
5. Preserve source commit IDs. Implement and test behavior afresh; do not import known defects from the old systems.

Run `make check-plan` to validate the local planning scaffold. It does not run application tests or start cloud resources.
