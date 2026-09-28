# Disposable AWS runtime deployment inventory

Status: audited from repository source; **no AWS deployment has been proven**.
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

1. **No GitOps application tree or bootstrap.** `infra/gitops/` has a README
   and this inventory, but no Argo CD `Application`/`ApplicationSet`, pinned
   controller installation, deployment ordering, or health gate. Terraform
   currently has no mechanism to install the charts.
2. **No deployable environment values.** Image fields deliberately default to
   empty. CI publishes digest-addressable images to GHCR, while Terraform
   creates ECR repositories; no promotion or digest transfer connects them.
   Chart `env`/`envFrom`, data/broker endpoints, secret references, and actual
   NetworkPolicy peers are not supplied for a disposable environment.
3. **Data and broker lifecycle missing.** No EKS release or managed resource
   currently supplies all required PostgreSQL databases, migrations,
   Kafka/Connect, RabbitMQ, Redis, Cassandra, OpenSearch, MQTT, and object
   storage with ordered readiness. The local Compose stack is not an AWS
   deployment definition.
4. **New runtime artifacts still require live proof.** The six added images and
   profiles need CI publication, digest promotion, validated environment secrets,
   data egress, and startup tests in EKS. The search indexer needs a durable
   `search-indexer-quarantine` PVC and index version selected after migrations.
   Other `services/*/README.md` directories may be scaffolds and should not be
   assumed deployable.
5. **Network and security are static only.** Chart NetworkPolicies permit DNS
   and listed pod peers. The environment still needs broker/data/IdP egress,
   ingress gateway and HTTPS routes, actual mesh principals, and a working
   network policy engine. Enabling Istio or KEDA in a chart requires their
   controllers/CRDs to be installed first. Canary analysis requires a live
   Prometheus metric and failed-analysis rollback evidence.
6. **Healthy Pods do not prove workflows.** Probes are configured for HTTP
   profiles, but there is no cross-service AWS acceptance sequence covering
   migrations, login/tenant membership, telemetry to Kafka to projection,
   dashboard/mobile alerts, ACK, rollback, and teardown.

Stage 11's observability acceptance is incomplete per `docs/STAGE_11_PLAN.md`.
Stage 12's cluster rollout/mesh/canary/security acceptance is incomplete per
`docs/STAGE_12_PLAN.md`. Stage 13's Tier 1 load and fault targets in
`docs/CAPACITY_MODEL.md` have no certification evidence and remain unmeasured.
