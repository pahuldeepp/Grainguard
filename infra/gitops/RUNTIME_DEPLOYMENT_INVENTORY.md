# Disposable AWS runtime deployment inventory

Status: source inventory refreshed 2026-09-28; **no AWS deployment has been proven**.
`scripts/check-image-inventory.sh` verifies the published Dockerfiles against
CI and Terraform ECR repository names. `scripts/helm-validate.sh` verifies
offline rendering. Neither check supplies an image digest, runtime secrets,
dependencies, or a GitOps installation.

| Runtime | Published Dockerfile | Helm profile | Minimum external wiring visible in source |
| --- | --- | --- | --- |
| dashboard | `apps/dashboard/Dockerfile` | `greenguard-dashboard` | Build-time OIDC settings; gateway HTTP origin |
| bff | `services/bff/Dockerfile` | `greenguard-bff` | OIDC issuer/audience/JWKS, read/alerts/saga endpoints, Redis, membership source |
| gateway | `services/gateway/Dockerfile` | `values/gateway.yaml` | OIDC, BFF/read/saga endpoints, membership source |
| device-service | `services/device-service/Dockerfile` | `values/device-service.yaml` | inventory PostgreSQL, OIDC, control-plane membership |
| read-api | `services/read-api/Dockerfile` | `values/read-api.yaml` | read PostgreSQL, Cassandra, Redis, OIDC/membership |
| workflow-alerts | `services/workflow-alerts/Dockerfile` | `values/workflow-alerts.yaml` | alerts PostgreSQL, Kafka, OIDC/membership |
| telemetry-ingest | `services/telemetry-ingest/Dockerfile` | `values/telemetry-ingest.yaml` | telemetry PostgreSQL; OIDC and Kafka for enabled paths |
| cdc-transformer | `services/cdc-transformer/Dockerfile` | `values/cdc-transformer.yaml` | Kafka, event schemas |
| projection-builder | `services/projection-builder/Dockerfile` | `values/projection-builder.yaml` | projection PostgreSQL, Kafka, event schemas |
| cache-invalidator | `services/cache-invalidator/Dockerfile` | `values/cache-invalidator.yaml` | Kafka, Redis |
| risk-engine | `services/risk-engine/Dockerfile` | `values/risk-engine.yaml` | risk PostgreSQL, Kafka, OIDC/membership |
| hardware-service | `services/hardware-service/Dockerfile` | `values/hardware-service-worker.yaml` | hardware PostgreSQL, Kafka, MQTT, unique persistent client ID |
| eventbridge-bridge | `services/eventbridge-bridge/Dockerfile` | `values/eventbridge-bridge.yaml` | Kafka, EventBridge bus, quarantine SQS URL, AWS identity |
| saga-orchestrator API/worker | `services/saga-orchestrator/Dockerfile` | `values/saga-api.yaml`, `values/saga-worker.yaml` | saga PostgreSQL, Kafka for worker, OIDC for API, API mTLS secret |
| tenant-control-plane | `services/tenant-control-plane/Dockerfile` | `values/tenant-control-plane.yaml` | control PostgreSQL and roles, OIDC/JWKS, lookup token, audit storage |
| billing-service | `services/billing-service/Dockerfile` | `values/billing-service.yaml` | billing PostgreSQL, test-mode Stripe credentials, OIDC/membership, Kafka |
| notification-service | `services/notification-service/Dockerfile` | `values/notification-service.yaml` | notifications PostgreSQL, RabbitMQ, provider credentials and contacts lookup |
| jobs-worker | `services/jobs-worker/Dockerfile` | `values/jobs-worker.yaml` | jobs PostgreSQL, Kafka, RabbitMQ, control-plane membership |
| cassandra-writer | `services/cassandra-writer/Dockerfile` | `values/cassandra-writer.yaml` | Cassandra schema, Kafka, migrations and recovery checkpoint |
| search-indexer | `services/search-indexer/Dockerfile` | `values/search-indexer.yaml` | Kafka, OpenSearch-compatible API, selected index version and durable quarantine PVC |

The paths in the profile column are relative to
`infra/helm/greenguard-service/` unless a chart name is shown. A profile is
only a template, not a deployed release. The exact required variables depend
on which optional source paths are enabled; runtime config and service README
files are authoritative.

## Runtime gaps before an end-to-end apply

The repository now contains a disposable GitOps application tree, controller
and data-plane charts, migration gates, secret lifecycle tooling, image digest
assembly/promotion tooling, and a Terraform bootstrap plus a bounded ready-Pod
gate. These are source-level deployment mechanisms; their presence does not
prove a successful AWS deployment. See
[`disposable/DEPLOYMENT_ORCHESTRATION.md`](disposable/DEPLOYMENT_ORCHESTRATION.md)
and [`disposable/DATA_PLANE.md`](disposable/DATA_PLANE.md) for the current
contracts and test boundaries. The fail-closed Terraform readiness gate remains
in place until the explicitly listed prerequisites and acceptance evidence are
complete.

1. **First-run requirements remain external or unproven.** Image publication,
   account-guarded ECR promotion, a routed runner for the private EKS API,
   operator-supplied identity provider settings and runtime secrets, and live
   data-service/migration readiness have not been exercised against AWS.
2. **User enrollment and end-to-end journeys are separate acceptance steps.**
   A real human must be enrolled through the documented first-admin flow after
   the control plane is reachable. The configured web and mobile OAuth clients,
   tenant membership, API journey, telemetry-to-alert/ACK journey, and physical
   iPhone connection have no live-provider/device proof.
3. **The workload gate is intentionally narrow.** It checks the exact
   application workload inventory, immutable images, generations, and ready
   Pods. It does not prove migrations, database correctness or isolation,
   authenticated journeys, telemetry/projection/alerts, or mobile behavior.
4. **Network and security are static only.** Chart NetworkPolicies permit DNS
   and listed pod peers. The environment still needs broker/data/IdP egress,
   ingress gateway and HTTPS routes, actual mesh principals, and a working
   network policy engine. Enabling Istio or KEDA in a chart requires their
   controllers/CRDs to be installed first. Canary analysis requires a live
   Prometheus metric and failed-analysis rollback evidence.
5. **Healthy Pods do not prove workflows.** Probes are configured for HTTP
   profiles, but the cross-service AWS acceptance sequence covering migrations,
   login/tenant membership, telemetry to Kafka to projection, dashboard/mobile
   alerts, ACK, rollback, and teardown remains pending.

Stage 11's observability acceptance is incomplete per `docs/STAGE_11_PLAN.md`.
Stage 12's cluster rollout/mesh/canary/security acceptance is incomplete per
`docs/STAGE_12_PLAN.md`. Stage 13's Tier 1 load and fault targets in
`docs/CAPACITY_MODEL.md` have no certification evidence and remain unmeasured.
