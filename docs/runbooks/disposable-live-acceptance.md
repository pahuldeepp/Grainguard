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

## Functional journeys

For each journey, save a timestamped command transcript or screenshot under
`evidence/` and record the expected result, actual result, operator and digest
in the manifest. Sanitize tokens, credentials, personal data and session
cookies before saving evidence. A `PASS` requires the actual service response,
not a rendered Helm manifest.

| Manifest id | Live action and required observation |
| --- | --- |
| `web-login` | Sign in through the deployed Cognito hosted page; browser returns to the dashboard and loads authenticated data. |
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
with the same deployed public Cognito/BFF endpoints. Record device model, iOS
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
`checks` array containing every ID above. Each check needs `status: "PASS"`,
`expected`, `observation`, `operator`, `observedAt` (UTC or offset timestamp),
and at least one `artifacts` entry with a repository-relative `path` under
`evidence/` and its lowercase `sha256`. Keep the manifest under `evidence/`
after sensitive content is removed.

Run `python3 infra/gitops/disposable/check-live-acceptance.py` before evidence
exists: it must exit nonzero. With a completed manifest, run:

```sh
python3 infra/gitops/disposable/check-live-acceptance.py evidence/disposable-live-manifest.json
```

A zero exit confirms only that the evidence inventory is complete and the
artifact hashes match. A reviewer must inspect the responses, isolation proof,
physical-device proof, cost/abort record and teardown inventory before marking
functional acceptance. Capacity, 24-hour soak and 30-day availability remain
separate Stage 13 gates in `docs/STAGE_13_PLAN.md`.
