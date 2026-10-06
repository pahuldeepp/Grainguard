# Disposable release orchestration boundary

## Image publication already implemented

The CI `publish` matrix builds every release image for Linux AMD64 and ARM64,
scans it, signs and verifies the immutable manifest with Cosign, and uploads
one exact-commit digest artifact per image. `assemble-ci-digests.rb` rejects
missing, extra, malformed, or mismatched revisions before producing the
Terraform release input. CI then checks anonymous GHCR access for every exact
manifest, so EKS does not need a GHCR credential just to pull that release.
`promote-images-to-ecr.rb` supports a later account-guarded copy of verified
multi-architecture manifests with preserved digests. ECR promotion cannot be
a prerequisite to the first apply that creates those repositories.

These checks establish publication contracts. They do not establish node
network egress, runtime image architecture, or healthy workloads. No registry
or AWS action was executed for this source audit.

## Private API execution requirement

Terraform's Helm provider runs on the machine running Terraform and connects
to the EKS endpoint with an AWS exec credential. A private EKS endpoint needs
a routed VPN/in-VPC runner before the first Helm operation. An external runner
cannot infer reachability from a successful EKS create. If choosing the
existing scoped public endpoint option, retain its operator `/32` restrictions
and account guards; never broaden access to bypass connectivity.

The Terraform graph runs `check-eks-api-reachability.py` after EKS, the general
node group, and cluster-admin access are ready, but before its first Helm
release. It checks the exact AWS account and cluster, `ACTIVE` state, a
temporary kubeconfig, API `/readyz`, and Kubernetes read authorization. A
private endpoint still requires the Terraform runner to have VPN or in-VPC
routing; this gate makes a missing route fail before controller charts start.
It does not provision a VPN/runner or allow a disconnected laptop to finish the
apply. Its fixture tests are offline and do not prove live endpoint reachability.

The first-run graph creates infrastructure, then checks runner reachability,
then installs controllers. The existing incomplete deployment readiness gate
remains in force; these checks do not make the root ready or bypass that gate.
Helm `atomic`, `wait`, and timeouts cover their release operations, not
application journeys.

## Read-only automatic application health gate

When `enable_application_tree` is selected, the Terraform root now attaches
`terraform_data.deployed_workload_acceptance` after `helm_release.gitops_bootstrap`.
Its local-exec adapter `run-deployed-workloads.py` writes temporary public
scope/release inputs and a temporary kubeconfig, then runs this gate while
Argo reconciles the child applications. A failed technical gate fails apply;
the separate resource avoids tainting/recreating the bootstrap Helm release.
This does not open the incomplete deployment readiness gate or establish the
remaining live journeys. For an independent post-deployment check, invoke:

```sh
python3 infra/gitops/disposable/check-deployed-workloads.py \
  cell-identity.json release-inputs.tfvars.json /private/path/cell-kubeconfig \
  --timeout 2400
```

Inputs:

- `cell-identity.json`: the exact public `disposable_cell_identity` Terraform
  output with `account_id`, `region`, `environment`, and `cluster_name`.
- `release-inputs.tfvars.json`: the verified CI assembled (or ECR promoted)
  artifact with `gitops_revision` and the complete `deployment_image_digests`
  inventory, plus immutable `migration_gate_image_digest` and
  `migration_sql_image_digest` values. Mutable application references and
  foreign registries/accounts are rejected.
- An explicit kubeconfig for this cell, with its inline EKS CA. The runner
  does not change kubeconfig or select a global context.

The runner first checks STS account, exact EKS ARN and ACTIVE status, endpoint
and CA equality with the selected kubeconfig, secure TLS configuration, then
`/readyz`. It reads cell-scoped Argo Applications from `argocd`, plus
Deployments, StatefulSets, Rollouts, Pods, CronJobs, and Jobs in `greenguard`,
with bounded subprocess/API deadlines. Every Argo Application for the cell
must report `Synced` and `Healthy` at the selected immutable GitOps revision;
every release Application must exist exactly once. Every release in
`contract.json` must have exactly one supported workload with an observed
current generation, all desired replicas updated/ready (and available for
Deployments), the exact immutable runtime image, and Ready running Pods.
StatefulSets also require matching update/current revisions. Sidecar images
are not confused with the contract runtime image. Output contains public
scope/result information; CLI diagnostics and raw kubeconfig/workload payloads
are not logged.

All ordinary BFF/service charts use Deployments. Dashboard supports an
optional Argo Rollout. **Rollout mode fails this gate**: Ready Pods alone do
not establish controller analysis or promotion. The orchestrator needs a
separate Argo controller status/promotion/analysis-result gate before enabling
that mode. The normal Deployment/StatefulSet/Pod query does not require the optional
Rollout CRD. Discovery collects Rollouts separately only when that CRD exists;
a missing contract Deployment still fails, so an absent CRD cannot hide a
replacement workload. DaemonSets, CronJobs and Jobs cannot substitute for
a contract's application Deployment/StatefulSet. The PostgreSQL migration
gate is separately required below; this script does not check controller or
other data workloads, public API journeys, tenant isolation,
telemetry/projection/alert flows, or iPhone behavior. Those remain separate
acceptance phases.

The Terraform acceptance wait requires every Job declared in
`contract.json` under `acceptanceJobs` to match its unique, mutually exclusive
label selector, use the exact immutable image digests from the release input,
and complete successfully. The PostgreSQL owner-migration/RLS Job remains
mandatory under the exact `greenguard.io/migration-gate=true` selector and
the immutable kubectl/psql images passed through Terraform. That Job waits for
all 38 central and shard owner migration Jobs, then checks owner databases and
roles, runtime grants, forced RLS, and shard placement admission. Additional
data-plane or user-journey Jobs must be declared with digest-pinned images and
real executable checks before they are counted; the current contract contains
only the PostgreSQL gate. Nested Argo Application sync waves are not treated
as proof that their child resources have converged. The default wait is 2,400
seconds (configurable from 60 to 3,600) to cover the 900-second owner Jobs and
1,800-second SQL gate.

## Public edge apply gate

When `enable_application_tree` is enabled, Terraform runs
`terraform_data.public_edge_acceptance` after workload and migration
acceptance. `run-public-edge.py` retries only transient health/readiness states
for at most 600 seconds. It confirms the selected target group belongs to the
exact non-production AWS account and region, checks the cell ownership tags,
requires every registered ingress target to be healthy, and verifies that the
two supplied CloudFront distribution IDs are deployed, tagged for this cell,
use the AWS-owned distribution hostnames with no aliases, and point through
the expected private ALB/VPC origin route. It then requests the dashboard root
and the BFF `/healthz` and `/readyz` endpoints over HTTPS. It does not follow
redirects, log response bodies, use credentials, or claim authenticated
tenant/user workflow coverage.

Terraform supplies identity, TargetGroup ARN, CloudFront domains, and
distribution IDs from its own resources; the local-exec adapter passes these
public values via environment variables and stores no credentials in state.
For a manual rerun, get the public outputs with
`terraform output -json disposable_cell_identity`,
`terraform output -json edge_target_group_binding`, and
`terraform output -json edge_urls`. Supply the dashboard and API CloudFront
distribution IDs from the same cell; the checker independently verifies
their AWS status, tags, aliases, domains and origin configuration.

```sh
python3 infra/gitops/disposable/check-public-edge.py \
  --cell-file cell-identity.json \
  --target-group-arn "$TARGET_GROUP_ARN" \
  --dashboard-url "$DASHBOARD_URL" \
  --api-url "$API_URL" \
  --dashboard-distribution-id "$DASHBOARD_DISTRIBUTION_ID" \
  --api-distribution-id "$API_DISTRIBUTION_ID"
```

Offline fixtures for both the checker and bounded retry adapter use stubbed
AWS/HTTPS calls only. They do not establish live AWS health or user sign-in.

## Remaining automatic acceptance work

The deployment must run separately scoped data-plane probes, authenticated
web/API and tenant-isolation journeys, and telemetry-to-projection/alert/ACK
checks. The evidence inventory requires distinct PostgreSQL shard/write/replica
freshness, PgBouncer transaction-pool, Kafka produce/consume and Connect
connector-status, Schema Registry compatibility, RabbitMQ publish/consume, Redis
tenant-cache, Cassandra tenant-partition, OpenSearch index/search, MQTT
TLS/authenticated publish/subscribe, object-storage audit-export roundtrip, and
OAuth discovery/JWKS probes. It also requires the web/iPhone login, tenant
isolation, alert creation/live update/ACK, telemetry projection, recovery, and
teardown journeys. Workload readiness and the PostgreSQL migration Job do not
satisfy these checks. The authoritative service probe IDs are listed in
`contract.json` under `phases[].probes` and must also appear in the evidence
manifest.

`check-live-acceptance.py` only validates that required inventory entries and
hashed evidence artifacts are present and structurally valid; it does not run
or independently attest any probe or journey. Even a structurally complete
inventory exits with status 2 and prints `BLOCKED` until an authorized reviewer
inspects the artifacts and records acceptance separately. It must not be used
as an acceptance PASS gate. Physical-iPhone acceptance needs the real device
and reviewed observations. All live AWS, registry, private endpoint, workload,
OAuth, telemetry and physical-iPhone proof remains pending.

Offline command: `python3 -m unittest discover -s infra/gitops/disposable -p
 test_check_deployed_workloads.py` (join the wrapped command onto one line).
Fixtures cover exact healthy images, stale generation, scale zero, partial
rollout, missing/extra/unready pods, StatefulSet revision mismatch, unsupported
Rollouts, account/endpoint/CA mismatches, deadline exhaustion, and redacted
command failures. Stubs perform no AWS/Kubernetes calls.

Recorded offline evidence: [workload gate tests](../../../evidence/tenant-sharding/deployment-orchestration/workload-gate-tests.log), [CI digest assembly](../../../evidence/tenant-sharding/deployment-orchestration/ci-digest-tests.log), [ECR promotion fixtures](../../../evidence/tenant-sharding/deployment-orchestration/ecr-promotion-tests.log), and [anonymous image pull fixtures](../../../evidence/tenant-sharding/deployment-orchestration/public-image-tests.log).

The focused runner suite passed 18 tests; [statement coverage](../../../evidence/tenant-sharding/deployment-orchestration/workload-gate-coverage.log) measured 129/137 statements (94%), passing the local 80% threshold. This is the runner scope, not full-repository or external Sonar coverage.

The Terraform adapter reuses the full cell/release inventory validator before
`aws eks update-kubeconfig`: malformed identities, `prod`/`production` scope
(case-insensitively), mutable
revisions, missing images and foreign references are rejected locally with no
AWS subprocess. All three temporary input/kubeconfig files are mode `0600`
before the health gate runs. [Adapter tests](../../../evidence/tenant-sharding/deployment-orchestration/adapter-tests.log) passed six tests, and [combined coverage](../../../evidence/tenant-sharding/deployment-orchestration/adapter-and-gate-coverage.log) is 95% (172/181 statements; adapter 98%, gate 94%).

The adapter also bounds its gate subprocess by the configured readiness timeout plus 120 seconds; invalid timeout values fail before AWS discovery. Malformed JSON diagnostics use a fixed message without decoder details or document contents.
