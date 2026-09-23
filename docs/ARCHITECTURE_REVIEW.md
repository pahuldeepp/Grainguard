# Architecture review: will the plan hold?

Review date: 2026-09-23, at commit `c49de77`. Scope: [GREENGUARD_MASTER_PLAN.md](../GREENGUARD_MASTER_PLAN.md) and every file in `docs/`, checked against the repository. Nothing was load-tested; this is a design and consistency review.

## Verdict

The plan is coherent and unusually careful about correctness. Its ingest path, outbox/CDC rules, crash matrix, tenant-isolation rules and gated scale ladder (G0–G8) would hold up. It is **not** production-ready today, and it does not claim to be: only Stage 01 is built. "No breakage" can only be shown by the Stage 11–14 gates, not by a document.

The gaps below are fixable plan additions. None of them requires changing the central invariants.

## What holds

| Area                     | Why it holds                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable ingest           | Reading, outbox, receipt and audit commit in one transaction; retries resolve through a stored receipt; 19-case crash matrix with a named test for each case.   |
| Event delivery           | At-least-once transport plus idempotent inboxes; offsets commit only after durable effect or confirmed quarantine; a contiguous commit frontier.                |
| Ordering and concurrency | Per-device `FOR UPDATE` on the stream row with a consistent lock order (pessimistic); version checks on bindings (optimistic).                                  |
| Tenant isolation         | Forced RLS, non-owner runtime roles, transaction-local tenant context safe for PgBouncer, composite tenant foreign keys, cache and subscription scoping.        |
| Scale model              | Arithmetic recomputes correctly (2M API rps, 1.67M events/s, 100 → 150 baseline cells, 417 → 626 burst cells). It is labelled a lower bound, not a claim.       |
| Cells                    | Bounded cells, one write owner per tenant, fenced promotion, no fleet-wide shared broker or writer.                                                             |
| Supply chain             | Actions pinned to commit SHAs, images pinned by digest, no tracked secrets, SBOM/Cosign planned.                                                                |
| Known source defects     | The plan names the old GrainGuard/CarePulse bugs (direct Kafka bypass, duplicate migrations, skipped DLQ errors, unscoped cache keys) and designs against each. |

## Gaps: patterns you asked for

| #   | Gap                                                                                                    | Current state                                                                                         | Recommended addition                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Choreography sagas                                                                                     | 0 mentions. Only orchestration (D11) and TCC (X04).                                                   | Add a choreographed flow where no central coordinator is needed (e.g. reading → risk → alert → notification) with its own compensation and correlation tests, and state when to choose each style.                              |
| P2  | Event sourcing                                                                                         | D08 is an optional lab only. The platform is CQRS + outbox.                                           | Keep it optional, but name one aggregate (e.g. alert lifecycle) for an event-sourced implementation with snapshots and upcasting, so the pattern is actually built.                                                             |
| P3  | Pessimistic vs optimistic as a rule (**resolved in 02a**: [ADR-0002](adr/0002-concurrency-control.md)) | Both are used, but no rule says which to choose.                                                      | Add a decision table: hot single-row contention → `FOR UPDATE`; low-contention user edits → version column + 409; money/quotas → serializable or `FOR UPDATE` with `NOWAIT`/timeout. Add lock-timeout and deadlock-retry tests. |
| P4  | Prisma locking (**resolved in 02a**: raw `FOR UPDATE` in `withTenant`)                                 | Prisma has no `FOR UPDATE` API.                                                                       | Document raw-SQL locking inside `$transaction`, and that tenant context must be set in the same interactive transaction.                                                                                                        |
| P5  | Extra datastores                                                                                       | MongoDB, ClickHouse, TimescaleDB, ScyllaDB, Neo4j and NATS are absent (not in either source project). | Only add as `labs/` profiles if wanted; do not put them on the critical path.                                                                                                                                                   |

## Gaps: production breakage risks

| #   | Risk                                                | Why it breaks                                                                                                              | Fix                                                                                                                                                                           |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Debezium snapshot under forced RLS                  | The CDC role has no tenant context, so a forced-RLS outbox returns zero rows. The initial snapshot silently emits nothing. | Give the replication role a documented, audited RLS exemption on `outbox_events` only; add a snapshot test to E03.                                                            |
| R2  | Prisma behind PgBouncer (**resolved in 02a**)       | Transaction pooling breaks session state and migrations unless configured.                                                 | Prisma 7 queries through `@prisma/adapter-pg` (no `pgbouncer=true` flag needed); migrations use a direct owner URL in `prisma.config.ts`; D03 proves no tenant context leaks. |
| R3  | Write amplification                                 | Every reading writes four rows including JSONB audit. At 1.67M readings/s the capacity model counts payload bytes only.    | Audit commands and admin actions, not every reading; add a measured WAL/index amplification factor to `capacity_assumptions.json`.                                            |
| R4  | Identity provider limits                            | Auth0 documents 100,000 organizations per tenant; the target is 10M. The plan notes this but picks no answer.              | Decide before Stage 09: first-party membership mapping with the IdP for authentication only is the likely answer.                                                             |
| R5  | Noisy neighbours                                    | 0 mentions of per-tenant limits inside a shared cell database.                                                             | Per-tenant rate limits, statement timeouts and connection quotas; a hot-tenant load test in Stage 13.                                                                         |
| R6  | Stage 02 is overloaded (**applied**: 02a/02b split) | RLS, PgBouncer, gRPC, NestJS CRUD, GraphQL/event schemas, auth and OTel helpers in one stage.                              | Split into 02a (models, migrations, RLS, PgBouncer, isolation tests) and 02b (auth, gRPC/HTTP contracts, shared helpers).                                                     |
| R7  | Stale-binding admission                             | Ingest fails closed when the binding feed is stale; a connector outage therefore stops all ingest in a cell.               | Make that an explicit, alerting SLO decision with a runbook, not a surprise.                                                                                                  |

## Gaps: production operations the plan covers thinly

| #   | Topic                              | Coverage                                                               | Needed                                                                                                                          |
| --- | ---------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Encryption at rest / key hierarchy | 2 mentions (KMS only as a quota item).                                 | Per-environment KMS keys, envelope encryption for sensitive columns, rotation schedule.                                         |
| O2  | Tenant deletion and personal data  | Soft delete (X13) only; "PII" appears twice.                           | Data classification, hard-delete/crypto-shred across Postgres, Kafka, Cassandra, search, backups and S3, with a deletion proof. |
| O3  | Data residency                     | 2 mentions.                                                            | Decide whether tenants are pinned to a region; it changes cell placement.                                                       |
| O4  | DDoS and penetration testing       | 0 mentions each.                                                       | Edge DDoS protection and a pre-launch external penetration test as gate G2 evidence.                                            |
| O5  | Migration rollback                 | Expand/contract exists (X14), rollback of a failed migration does not. | State that migrations are forward-only and test a failed deploy's recovery.                                                     |

## Repository state versus the plan

- Built: dashboard, device-service, telemetry-ingest (health checks), PostgreSQL, CI, SonarQube (100% coverage locally, gate passed), CodeRabbit.
- Scaffolded only (README or one file): 18 of 21 services/apps, all of `infra/` (Helm, Kubernetes, Terraform, GitOps, observability, cells), `packages/`.
- Stage 01 is closed: green CI with the 100% gate and deliberate-failure evidence. A release deploy and rollback has still not been exercised.
- Stage 02a (inventory data layer) is built; 02b is next.

## Recommended order

1. Close Stage 01: green remote CI, broken-check evidence, update the stale docs.
2. Fold P3, P4, R1, R2 and R6 into the Stage 02 plan before writing its code.
3. Decide R4 and O3 before Stage 09; add P1, P2, R3, R5, O1, O2, O4 and O5 to the backlog stages that own them.
