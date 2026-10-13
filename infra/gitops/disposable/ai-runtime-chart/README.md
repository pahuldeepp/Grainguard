# Disposable AI runtime

Disabled by default. This chart packages the actual Knowledge API, indexer,
outbox relay, suggestion analytics, conversation retention and summary processes;
delegated Advisor API; Model Gateway; usage relay and consumer. It also owns a
standalone authenticated TLS Redis cache/admission store and a ClamAV service
with signature updates. PostgreSQL remains the budget authority.

The parent Argo Applications are `greenguard-ai-database-bootstrap` (wave 22)
and `greenguard-ai-runtime` (wave 30). Their source is an exact Git revision.
Inside the runtime child:

| Wave | Required work |
| --- | --- |
| 0 | Network/RBAC/admission boundaries and parser namespace |
| 5 | Run the approved parser image under the real runsc RuntimeClass on Ready dedicated parser nodes; require actual successful container status/image ID |
| 10 | Knowledge, Advisor and Gateway guarded migrations with dedicated migrator roles |
| 12 | Provision explicitly approved platform/tenant/user budget caps through the guarded owner command |
| 15 | Ready TLS Redis and ClamAV with actual clean-stream scan |
| 20 | APIs and workers |

The UTC budget reconciliation CronJob runs daily with the same approved caps
and owner role; daily reconciliation repairs a missed month boundary. The
provisioner creates the current UTC month only. Absent provisioning makes model
calls fail closed. Counters are never reset by bootstrap. The separate parser janitor removes only terminated bounded
parser pods with UID/resourceVersion deletion preconditions.

## Inputs and identity

`values.yaml` is the complete parent contract. Enabled rendering requires exact
AWS scope/cell/environment, Secret synchronization epoch, immutable approved
GHCR or exact-cell ECR service images, official immutable ClamAV image, exact
RDS endpoint, explicit model/provider/OIDC origins, and bounded network CIDRs.
External provider and issuer/JWKS origins require HTTPS. Cognito access-token
mode uses explicit client IDs; audience mode requires an audience.

Terraform owns the dedicated S3 bucket/KMS keys, distinct Knowledge API/indexer
IAM roles and actual Pod Identity associations, plus the dedicated parser nodes
and RuntimeClass. Readiness is tested by the parser gate, not by a caller flag.
Pod Identity credential egress is restricted to `169.254.170.23/32:80`.

Services are private in `greenguard`:

| Service | Port | Service account |
| --- | --- | --- |
| knowledge-service | 8080 | knowledge-api |
| knowledge-indexer | worker | knowledge-indexer |
| mcp-gateway | 8090 | mcp-gateway |
| grain-advisor | 8088 | ai-runtime |
| model-gateway | 8080 | ai-runtime |
| other Knowledge/usage workers | worker | ai-runtime |
| ai-redis | 6379, TLS only | no API token |
| clamav | 3310, private scanner | no API token |

Knowledge and Advisor use explicitly opted-in, exact mesh service URLs. HTTP
APIs require strict Istio mTLS and exact allowed caller principals. BFF uses
`bff-greenguard-bff`; the shared cell APIs use the existing Tenant Control Plane
and Workflow Alerts names. The parser namespace has no network access, tokens,
cloud identity, host volumes or Secret mounts. Admission restricts parser pods
to the exact image, runsc handler, UID/security posture and resource bounds.

## Fixed Secrets

All Secrets are synchronized into `greenguard` before either child Application.
No Secret bytes are passed in Helm values. Secret file inputs are projected as
0440, copied by UID/GID 10001 to memory with mode 0600, and mounted read only.

| Secret | Keys |
| --- | --- |
| greenguard-knowledge-runtime | database-url, control-lookup-token, namespace-hmac-key, pinecone-api-key, redis-url, gateway-tokens.json, relay-tenants.json, retention-scopes.json, kafka-username, kafka-password |
| greenguard-knowledge-worker-runtime | database-url |
| greenguard-advisor-runtime | database-url, membership-service-token, alerts-service-token |
| greenguard-model-gateway-runtime | access.json, controls.json, redis-url, budget-dsn, voyage-key, anthropic-key |
| greenguard-model-gateway-usage | relay.json, consume.json |
| greenguard-model-gateway-budget-bootstrap | budget-dsn, budget-caps.json |
| greenguard-knowledge-migrator / greenguard-advisor-migrator / greenguard-model-gateway-migrator | database-url |
| greenguard-ai-redis | password, server.crt, server.key, ca.pem |
| greenguard-rds-ca / greenguard-ai-kafka-ca | ca.pem |
| tenant-control-plane-config | CONTROL_LOOKUP_TOKEN |

The database bootstrap additionally requires `greenguard-rds-bootstrap` and
`greenguard-ai-database-roles`. API and background Knowledge database identities
are separate. Worker projections do not expose the API database credential;
file projections and environment references are narrowed by process profile.
Readiness verifies the exact non-superuser/NOBYPASSRLS worker role and relevant
authenticated Kafka topic, Gateway or scanner dependency. Gateway controls
cannot opt out of Redis/PostgreSQL budget enforcement.

## Storage and shutdown

Redis has no PVC and uses a bounded memory cache with `noeviction`. ClamAV owns
`ai-clamav-signatures` (10 GiB) on `greenguard-disposable-gp3`, whose reclaim
policy is Delete. Argo pruning must complete before PVC/EBS teardown and before
controller/node termination. The parent disposal gate captures EBS handles and
waits for actual volume disposal. The parser admission policies and cluster
RBAC are cell-labeled and pruned with this Application. Gateway termination
grace is 150 seconds; other API/worker profiles use 45 seconds.

## Offline verification and remaining live acceptance

```sh
PYTHONDONTWRITEBYTECODE=1 python3 infra/gitops/disposable/ai-runtime-chart/test_chart.py
helm lint infra/gitops/disposable/ai-runtime-chart
```

These tests check disabled defaults, approved inputs, exact Secrets/roles,
entrypoints, hardening, parent ownership/waves, probes and sandbox boundaries.
They do not prove Kubernetes scheduling, admission enforcement, NetworkPolicy,
Pod Identity, provider credentials, hosted membership, S3/KMS access, signature
updates, or Argo/PVC/EBS disposal. Real runsc execution, clean and rejected PDF
flows, tenant denial, model budget settlement and usage publication/consumption
must be accepted in the authorized cell before claiming cloud E2E readiness.
The BFF-only MCP gateway and its delegated read/proposal adapters are deployed.
Advisor durable checkpointing and LangGraph planner execution remain disabled
until their owner implementation and migrations are supplied.

ClamAV configuration follows the upstream [configuration guide](https://docs.clamav.net/manual/Usage/Configuration.html)
and [Docker deployment guidance](https://docs.clamav.net/manual/Installing/Docker.html).
Its signature loading/update memory requests are intentionally separate from
any reduced local test budget; no scalability proof is implied.
