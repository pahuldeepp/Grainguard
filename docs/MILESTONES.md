# GreenGuard milestone tracker

All 14 implementation milestones are defined in the [acceptance backlog](IMPLEMENTATION_BACKLOG.md), including dependencies and exit gates. The archive and architecture form Stage 00. A milestone is complete only when its exit evidence exists; this tracker does not turn architectural plans into delivered functionality.

| Stage | Milestone | Status |
|---|---|---|
| 00 | Archive, source inspection, architecture and coverage register | Complete — [evidence](../evidence/STAGE_00_VALIDATION.md) |
| 01 | Reproducible local workspace, first services, database and CI | In progress — local foundation verified; CI/SonarQube configured but coverage gate failing; results in [evidence](../evidence/STAGE_01_VALIDATION.md); [delivery status](CI_CD.md) |
| 02 | Domain model, contracts, migrations, authentication and tenant RLS | Planned |
| 03 | Durable telemetry write, transactional outbox, idempotency and audit | Planned |
| 04 | Kafka, schema registry, CDC, retries and DLQ | Planned |
| 05 | CQRS read models, history, search and replay | Planned |
| 06 | Grain risk, alerts, background jobs and notifications | Planned |
| 07 | Sagas, compensation, concurrency and coordination | Planned |
| 08 | Gateway, GraphQL BFF and complete dashboard workflows | Planned |
| 09 | SaaS identity, billing, quotas, entitlements and audit export | Planned |
| 10 | Remaining technology profiles, adapters, mobile and reference labs | Planned |
| 11 | End-to-end observability, SLOs and runbooks | Planned |
| 12 | Secure delivery, infrastructure, Kubernetes and GitOps | Initial GitHub Actions, SonarQube and local Docker delivery implemented; Kubernetes/GitOps/cloud work planned |
| 13 | Capacity, load, soak, chaos and resilience certification | Planned |
| 14 | Recovery, regional operations, incident exercises and final coverage audit | Planned |

The [coverage matrix](COVERAGE_MATRIX.md) tracks 141 architecture requirements; the [technology catalog](TECHNOLOGY_CATALOG.md) retains 368 historical entries and their intended destinations. The [scale plan](SCALE_AND_PRODUCTION_READINESS.md) defines the 10-million-account, organization and concurrent-user targets. Those targets require measured cell/fleet evidence and operational gates, not just a passing local setup.

Calendar dates will be estimated from measured implementation throughput after the first vertical slice. Milestones currently specify scope, dependency and completion evidence, not promised delivery dates.
