# Disposable AWS cell live acceptance

Status: **blocked until a real cell is deployed and evidence is reviewed**.
The offline inventory checker validates evidence files and scope, not service
behavior. Do not describe a passing inventory as Stage 13 capacity or
availability certification.

## Before the run

Record the AWS account, region, EKS cluster, Terraform state identity, exact
Git revision and image digests. Complete the secret preflight, owner migrations,
data dependencies, membership enrollment, routing and network peer checks.
Set an approved cost/time ceiling, abort conditions, cleanup owner and two
isolated test tenants. Keep test passwords and tokens out of evidence.

## Data dependency probes

Run each probe against the deployed disposable cell and retain redacted,
timestamped request/response evidence. A healthy Pod, open TCP port, rendered
manifest, or migration Job alone does not pass a probe.

| Manifest id | Live action and required observation |
| --- | --- |
| `postgres-shard-read-write-replica-freshness` | Write through the tenant's selected shard primary, observe the read path honor the required version/watermark, and confirm replica freshness or primary fallback. |
| `pgbouncer-transaction-pool` | Connect through the application PgBouncer endpoint, run a transaction and verify it returns to the pool without leaking session state. |
| `kafka-produce-consume` | Produce a uniquely identified event to an authorized topic and consume it with the intended workload identity. |
| `kafka-connect-connector-status` | Verify the required connector is registered, RUNNING, and advances its source offset for a disposable test event. |
| `schema-registry-subject-compatibility` | Fetch the deployed subject/version and verify an approved compatible schema can be checked without registering an unintended schema. |
| `rabbitmq-publish-consume` | Publish a uniquely identified message to the intended exchange/queue and consume it with the expected acknowledgement semantics. |
| `redis-tenant-cache-roundtrip` | Fill and retrieve a tenant-scoped cache entry, verify cross-tenant separation, and exercise the configured invalidation path. |
| `cassandra-tenant-partition-roundtrip` | Write and read a disposable record using the tenant/device/day partition key and the runtime TLS/auth identity. |
| `opensearch-index-search` | Index a disposable tenant-scoped document, refresh/search it through the application identity, and verify tenant filtering. |
| `mqtt-tls-auth-publish-subscribe` | Connect with the provisioned device identity and trusted TLS, publish/subscribe only to its authorized topic, and verify an unauthorized topic is rejected. |
| `object-storage-audit-export-roundtrip` | Produce a signed audit export, upload it to the owned bucket, download/verify its signature, and confirm an unauthorized object access is denied. |
| `oauth-discovery-jwks` | Fetch the configured HTTPS issuer discovery document and JWKS; verify issuer, audience/client settings, key availability, and TLS validation. |

## Functional journeys

For each journey, save a timestamped command transcript or screenshot under
`evidence/` and record the expected result, actual result, operator and digest
in the manifest. Sanitize tokens, credentials, personal data and session
cookies before saving evidence. A `PASS` requires the actual service response,
not a rendered Helm manifest.

| Manifest id | Live action and required observation |
| --- | --- |
| `web-login` | Sign in through the selected OIDC provider using Authorization Code + PKCE; the browser returns to the registered dashboard callback and loads authenticated data for the enrolled tenant. This is provider-neutral: Cognito is used only when `identity_mode = "cognito"` is explicitly selected. |
| `api-auth` | Call the deployed BFF as the enrolled user; valid token succeeds, expired/invalid token is denied. |
| `tenant-isolation` | Use two enrolled tenants; a tenant A identity cannot read or acknowledge tenant B data through the deployed API. |
| `alert-create` | Send a sensor reading that crosses an approved rule; one durable alert appears with correct tenant/device identity. |
| `alert-live-update` | With the dashboard open, create an alert; a subscribed client sees it once, then reconnect and check replay. |
| `alert-ack` | A permitted user acknowledges the alert; a duplicate attempt has one durable effect, and an unauthorized user is denied. |
| `telemetry-projection` | Trace one accepted reading through ingestion and projection; compare canonical state and read API after queue drain. |
| `recovery` | Execute only an approved disposable fault; record restored settings, bounded recovery, no acknowledged-event loss and no duplicate external effect. |
| `teardown` | Destroy the disposable owners in documented order; save the final account/resource inventory and chargeable-resource exceptions. |

## Physical iPhone

Use a signed Release or reachable Debug build on a physical iPhone, configured
with the selected deployed OIDC issuer and BFF endpoints (Cognito only when
explicitly selected). Record device model, iOS
version, app build digest/version, public client ID and callback registration.
Keep device identifiers and account secrets out of public evidence.

| Manifest id | Live action and required observation |
| --- | --- |
| `iphone-physical-login` | Browser Authorization Code + PKCE returns to the app; alert list/detail loads for the enrolled tenant. |
| `iphone-alert-ack` | A permitted user acknowledges an alert on the device; the deployed API and another client show the same durable state. |
| `iphone-signout-offline` | Sign out and sign in again; expired token and temporary offline behavior do not expose stale tenant data or silently acknowledge an alert. |

## Evidence inventory

Create a private JSON manifest with `schemaVersion: 1`, `scope` fields
`accountId`, `region`, `cluster`, `gitRevision`, `startedAt`, `endedAt`, and a
`checks` array containing every ID in the data probe and functional journey
tables above. Each check needs `status: "PASS"`,
`expected`, `observation`, `operator`, `observedAt` (UTC or offset timestamp),
and at least one `artifacts` entry with a repository-relative `path` under
`evidence/` and its lowercase `sha256`. Keep the manifest under `evidence/`
after sensitive content is removed.

Run `python3 infra/gitops/disposable/check-live-acceptance.py` before evidence
exists: it must exit nonzero. With a completed manifest, run:

```sh
python3 infra/gitops/disposable/check-live-acceptance.py evidence/disposable-live-manifest.json
```

Exit status 2 means the inventory is structurally complete and artifact hashes
match; it is still `BLOCKED`, not an acceptance pass. The checker never returns
zero for a complete evidence manifest. An authorized reviewer must inspect the
responses, isolation proof, physical-device proof, cost/abort record and teardown
inventory, then record acceptance separately. Capacity, 24-hour soak and 30-day
availability remain separate Stage 13 gates in `docs/STAGE_13_PLAN.md`.
