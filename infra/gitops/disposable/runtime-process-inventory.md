# First-cell executable process inventory

This is an offline source audit, not evidence of AWS deployment. Contracted
workloads still need image promotion, Secret materialization, trusted tenant
ownership bootstrap and live acceptance.

## Continuous processes

| Executable                                                                                                                                                                                                                                                                                                           | Contract status                       | First-cell responsibility                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dashboard, BFF, gateway, device-service HTTP, read-api HTTP, workflow-alerts, telemetry-ingest, cdc-transformer, projection-builder, cache-invalidator, risk-engine, hardware worker, EventBridge bridge, saga API/worker, control API, billing, notification service, jobs-worker, Cassandra writer, search-indexer | Existing releases                     | Existing application/consumer entrypoints from each image's CMD/ENTRYPOINT                                                                                                                     |
| device `dist/saga/main.js`                                                                                                                                                                                                                                                                                           | Added device-saga-worker              | Inventory side of provisioning saga; main HTTP process does not start it                                                                                                                       |
| device `dist/tenant-projection/main.js`                                                                                                                                                                                                                                                                              | Added device-tenant-projector         | Apply tenant-created events before inventory commands; separate inventory_projector registry                                                                                                   |
| device `dist/entitlements/projector.js`                                                                                                                                                                                                                                                                              | Added inventory-entitlement-projector | Inventory entitlements and per-partition feed health; same scoped projector registry, distinct Kafka group                                                                                     |
| telemetry `entitlement-projector` argument                                                                                                                                                                                                                                                                           | Added telemetry-entitlement-projector | Telemetry entitlements/feed health; telemetry_entitlement_projector registry                                                                                                                   |
| read-api `dist/entitlements/projector.js`                                                                                                                                                                                                                                                                            | Added read-entitlement-projector      | Read entitlements/feed health; read_entitlement_projector registry, authenticated tenant placement and transaction admission                                                                   |
| control `dist/entitlements/projector.js`                                                                                                                                                                                                                                                                             | Contracted release                      | Central control entitlements/feed health with control_entitlement_projector role; deployment health and end-to-end acceptance remain unproven until live EKS validation                        |
| `packages/entitlements/dist/heartbeat.js`                                                                                                                                                                                                                                                                           | Added entitlement-heartbeat           | Publishes a heartbeat to every billing lifecycle partition; reuses billing-service Kafka identity and has write access only to the lifecycle topic                                               |
| notification `dist/contacts-projector-main.js`                                                                                                                                                                                                                                                                      | Added notification-contacts-projector | Projects versioned contact CDC into the Terraform-owned DynamoDB table using a Pod Identity role limited to PutItem on that table; reuses notification-service Registry/Kafka configuration |
| control `dist/audit/worker.js`                                                                                                                                                                                                                                                                                      | Contracted release                      | Private `/readyz` worker, audit signing configuration, scoped S3 Pod Identity and per-shard read registry are wired in Terraform/GitOps; signed upload/download and live worker acceptance remain blockers |

Telemetry's regular entrypoint starts its device binding and saga binding
consumers. Billing's regular entrypoint starts its billing worker and configured
Kafka consumer. Jobs' regular entrypoint owns its queue/consumer processing.
Those integrated loops do not require extra releases. Go migrator commands,
projection version provisioning, MQTT fixture programs and operator DLQ/redrive
commands are explicit bounded operations, not additional continuous services.

Projection Builder's operator replay (`scripts/projection-replay.mjs`) is also
not a deployed release or part of the Stage 12 live acceptance contract. It
rejects `SHARD_REGISTRY_FILE` before opening PostgreSQL/Kafka because the
shadow-target, tenant-scoped checkpoint/manifest, and move-fencing protocol is
not implemented for sharded tenants. Do not count sharded replay/rebuild as an
available recovery operation; it has no fixed-primary fallback.

Projection `cmd/maintain` is a bounded read-side history partition maintenance pass using
PROJECTION_MIGRATION_URL. The deployment contract defines one scheduled maintenance
CronJob per shard, each with that shard's projection-history-maintenance Secret,
after migrations. The initial per-shard Job and scheduled CronJobs are declarative
deployment configuration; live scheduling, RDS permissions, execution and recovery
still require EKS acceptance. No migrator credential is mounted into a normal worker.

## Registry and SQL contracts

- Device saga reuses greenguard-shard-routing-device-service, service
  device-service, database greenguard_inventory, role inventory_app.
- Device tenant/entitlement projectors use
  greenguard-shard-routing-inventory-projector, service device-service,
  database greenguard_inventory, role inventory_projector.
- Telemetry entitlement projector uses
  greenguard-shard-routing-telemetry-entitlement-projector, service
  telemetry-ingest, database greenguard_telemetry, role
  telemetry_entitlement_projector.
- Read entitlement projector uses
  greenguard-shard-routing-read-entitlement-projector, service read-api,
  database greenguard_read, role read_entitlement_projector. It resolves each
  event tenant, opens only its primary pool, installs tenant/shard/incarnation/
  epoch after BEGIN and invokes physical DB admission before business SQL.
  Quiescing/mismatched routes connect to no pool; rejected admission rolls back.
  Heartbeat fanout updates only global partition feed-health rows in all four
  pools. Startup failure and idempotent shutdown close every private pool.

All registries contain exactly four actual RDS shards and verified TLS URLs;
projector role passwords derive from the approved shard bootstrap inputs.
Runtime image/config Kafka principals are reused explicitly through contract
kafkaPrincipal. Existing ACLs already name distinct worker groups; no additional
broad principal or global grants are introduced.

## Central control projector constraints

The control entitlement projection intentionally remains in the central control
database. Its transaction installs tenant/identity RLS context through inScope;
SQL inserts/updates the event tenant only and a source-version predicate rejects
replays. The dedicated role has SELECT/INSERT/UPDATE on tenant_entitlements and
partition feed-health only; the tenant table has ENABLE/FORCE RLS. Its URI is
Terraform-derived using CONTROL_ENTITLEMENT_PROJECTOR_PASSWORD and verified RDS
CA, not an operational shard URL. This central projector does not install
operational shard incarnation/epoch or invoke shard writer admission. Moving the
control authority to shards would require a separate authority/RLS contract; it
cannot reuse an operational owner registry as a shortcut.

Six shard-aware projector/saga profiles plus heartbeat/contact release render
checks provide local evidence. Audit export and scheduled partition maintenance
remain explicit deployment gaps. The DynamoDB table/endpoint/IAM contract is
static configuration only; no live AWS or EKS behavior is proven.

The device saga worker now exposes a private health listener without a
Kubernetes Service. `/healthz` proves the process event loop can answer; its
`/readyz` additionally requires a recent Kafka consumer heartbeat and a
successful result-database polling pass. The other event-driven worker commands
remain without dependency readiness probes: their idle periods do not provide a
safe continuous database check through the current tenant-scoped shard routing
interface. Do not treat their Kubernetes Pod Ready state as proof that their
broker/database processing path is healthy.

The saga-orchestrator worker exposes loopback-only health endpoints and uses
exec probes, so its probe port needs no NetworkPolicy ingress exception. Its
`/healthz` requires fresh progress from every configured shard loop and fails
when a result record remains stuck in processing beyond 90 seconds. `/readyz`
also requires an assigned result-topic partition; Kafka rebalance callbacks
clear readiness until assignment returns. This is local runtime instrumentation,
not proof of live Kafka ACLs or deployed broker behavior.
