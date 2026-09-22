# Implementation from the basics

Build in this order. Stage 00 (archive, inspection and architecture scaffold) is complete. Stage 01 local foundation is implemented and locally verified; remote CI remains pending. Stages 02–14 are planned. See the [live milestone tracker](MILESTONES.md). Estimates are intentionally omitted until the first vertical slice is measured. One feature is complete only when its executable acceptance evidence is saved.

The confirmed target is all three dimensions: 10m accounts, 10m tenant organizations, and 10m concurrent active users. [Scale and production readiness](SCALE_AND_PRODUCTION_READINESS.md) is part of every stage: introduce bounded tenancy/placement contracts early, then certify cells and the regional fleet in Stages12–14. A passing local demo does not satisfy those capacity gates.

| Stage | Deliverable | Dependencies | Acceptance / exit gate |
|---|---|---|---|
| 01 | Reproducible foundation: Git conventions, runtime pins, package/workspace layout, Make targets, Docker profiles, lint/test entry points, CI, local secrets templates | Archive + coverage register | Fresh machine runs documented bootstrap; supported versions locked; no cloud account needed; CI fails deliberately broken sample test |
| 02 | Domain and contracts: tenant/site/bin/device models, Postgres, migrations, RLS/PgBouncer, Go gRPC and Nest CRUD, HTTP/GraphQL/event schemas, shared auth/OTel helpers | 01 | Two tenants can create/read only their data; empty and upgrade migrations pass; generated clients compatible |
| 03 | First durable vertical slice: authenticated device reading → atomic reading/outbox transaction; inbox/idempotency and audit | 02 | Duplicate request returns same result; injected crashes before/after commit lose no committed reading/event; concurrent writes preserve invariant |
| 04 | Kafka KRaft, Registry, Debezium/Connect, canonical CDC transform, topic provisioning, consumer idempotency, DLQ, bounded recovery relay | 03 | Committed reading arrives after connector/broker outage; duplicate/reordered delivery safe; poisoned event isolated; CDC offset/WAL retention visible |
| 05 | CQRS dashboard/site/alert projections, separate read DB, Cassandra history, Elasticsearch indexing, replay tooling | 04 | Rebuild from retained source matches reference state; tenant reads isolated; freshness visible; Cassandra retention/index failures tested |
| 06 | Grain risk, alert lifecycle, acknowledgements, RabbitMQ jobs, notifications and DLQ replay | 05 | Synthetic telemetry drives score → alert → delivery → acknowledgement; duplicates/retries do not duplicate effect; acknowledge route works |
| 07 | Durable provisioning saga, asset bindings, compensation, serializable/optimistic concurrency, Redis and etcd coordination exercises, mTLS | 04,06 | Timeout/duplicate/late response and process-crash matrix passes; state/commands atomic; stale leader fenced; compensation observable |
| 08 | Express edge + GraphQL BFF, DataLoader, subscriptions, cache-aside, React dashboard, Storybook, virtualized lists and browser tests | 05,06 | User registers device, sees reading/risk, acknowledges alert; cross-tenant REST/GraphQL/WS/cache tests all deny access; reconnect restores state |
| 09 | SaaS: Auth0 teams/SSO, roles, API keys, quotas, Stripe metering/subscriptions, audit export, feature flags | 08 | Sandbox purchase/webhook/replay/cancel flows correct; membership revocation works; tenant-scoped entitlements and audit proven |
| 10 | Full technology profiles: OpenSearch, Memcached, MySQL import CDC/SQLAlchemy/Alembic, DynamoDB/OpenFeature, CDK serverless S3/Lambda/SQS/EventBridge, all notification adapters, mobile, synthetic FHIR reference lab | 06,08,09 | Every profile has a run command and equivalent contract suite; reference clinical data cannot enter grain scoring; provider errors/retries tested |
| 11 | Complete observability: OTel collector, metrics/logs/traces, exporters/probes, Grafana, Sentry/profiling, SLOs/error budgets, runbooks | Instrumentation from 02; end-to-end flow from 08 | One trace crosses all transports; synthetic fault triggers correct actionable alert; dashboard matches actual labels/routes |
| 12 | Delivery: images, SBOM/Cosign, scanners, Terraform/CDK ownership, Kubernetes/Helm, secret injection, ArgoCD/Rollouts, mesh profiles, cloud edge | 09,10,11 | Required CI gates block bad code/image; canary rollback triggered by real metrics; staging reproduces core flows before production promotion |
| 13 | Capacity and resilience: k6, soak, backpressure, Redis cluster, Citus lab, profiling, chaos, autoscaling and mesh comparison | 11,12 | Measured load meets chosen SLOs; no unbounded resource growth; faults have bounded recovery; all scale/comparison profiles executed |
| 14 | Operational completion: backup/restore, PITR, multi-region, MirrorMaker2, failover/failback, incident exercises, cost/capacity and final coverage audit | 12,13 | Measured RPO/RTO, clean-environment restore, repeatable operations, all coverage rows with evidence and no unclassified dependency |

## First implementation ticket — Stage 01

Create a thin workspace with `services/telemetry-ingest` (Go), `services/device-service` (NestJS), `apps/dashboard` (React/Vite), and the first Postgres profile. Pin runtime and tool versions based on reproducible compatibility checks against the archived manifests. Add health/readiness contracts, format/lint/test commands, `.env.example` with placeholders, and a non-masking CI workflow. Do not start every datastore in the first exercise.

Acceptance: a new checkout can bootstrap using documented commands; the database reports healthy; every initial component has a real test; `make verify` fails for a failed required check. Save the resulting command transcript, dependency locks, image digests and CI run URL under a stage evidence directory. Next implement the tenant/site/device model and two-tenant RLS tests before publishing telemetry.

Use [the first vertical slice design](FIRST_VERTICAL_SLICE.md) for the exact transaction/outbox/inbox/acknowledgement sequence and proposed contracts. Use [platform contracts and operations](PLATFORM_CONTRACTS_AND_OPERATIONS.md) for later domain and deployment boundaries.

## Defects the rebuild must not carry forward

The source audits provide exact file/line evidence. Use these as targeted regression requirements:

- GrainGuard: duplicate migration numbers; Dockerfile case mismatches; required CI jobs missing from final gate; nonblocking security scans that can manufacture empty reports; alternate ingest path bypassing the outbox; saga dual writes; missing middleware wiring; tenant checks absent from latest-device path; deployment probe/metric drift.
- CarePulse: advertised 13 vs actual 14 service directories; dashboard/contracts scaffolds; telemetry write path disconnected from risk topic; incompatible event envelopes; competing projection schemas and a consumer not started; alert table ownership conflict; acknowledgement route missing; GraphQL subscription tenant argument risk; inconsistent HTTP/WS JWT policy; search resolver pointing to an absent API; Python CI suppressing failures.

## Definition of done per feature

Contract and owner documented; implementation wired at runtime; reproducible tests cover happy path, tenant isolation, duplicates and relevant failures; migration/rollback policy clear; logs/metrics/traces present; local and CI commands pass without suppression; operational failure/recovery described. Retain the source reference and coverage IDs in the implementation change.

Archive console output after each stage while it is still available. Retained GitHub records are useful historical evidence; rerunning a pipeline creates new evidence and does not recover an expired original log.
