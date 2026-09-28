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

A preflight cannot contact an EKS endpoint that has not been created yet.
The deployment orchestrator must own infrastructure creation followed by a
reachability gate and application deployment, or run from an already routed
runner. The existing incomplete deployment readiness gate remains in force;
this runner does not make the root ready or bypass that gate. Helm `atomic`,
`wait`, and timeouts cover their release operations, not application journeys.

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
  --timeout 900
```

Inputs:

- `cell-identity.json`: the exact public `disposable_cell_identity` Terraform
  output with `account_id`, `region`, `environment`, and `cluster_name`.
- `release-inputs.tfvars.json`: the verified CI assembled (or ECR promoted)
  artifact with `gitops_revision` and the complete `deployment_image_digests`
  inventory. Mutable references and foreign registries/accounts are rejected.
- An explicit kubeconfig for this cell, with its inline EKS CA. The runner
  does not change kubeconfig or select a global context.

The runner first checks STS account, exact EKS ARN and ACTIVE status, endpoint
and CA equality with the selected kubeconfig, secure TLS configuration, then
`/readyz`. It reads Deployments, StatefulSets, Rollouts and Pods in `greenguard`
with bounded subprocess/API deadlines. Every release in `contract.json` must
have exactly one supported workload with an observed current generation,
all desired replicas updated/ready (and available for Deployments), the exact
immutable runtime image, and Ready running Pods. StatefulSets also require
matching update/current revisions. Sidecar images are not confused with the
contract runtime image. Output contains public scope/result information;
CLI diagnostics and raw kubeconfig/workload payloads are not logged.

All ordinary BFF/service charts use Deployments. Dashboard supports an
optional Argo Rollout. **Rollout mode fails this gate**: Ready Pods alone do
not establish controller analysis or promotion. The orchestrator needs a
separate Argo controller status/promotion/analysis-result gate before enabling
that mode. The normal Deployment/StatefulSet/Pod query does not require the optional
Rollout CRD. Discovery collects Rollouts separately only when that CRD exists;
a missing contract Deployment still fails, so an absent CRD cannot hide a
replacement workload. DaemonSets, CronJobs and Jobs cannot substitute for
a contract's application Deployment/StatefulSet. This script does not check
controller or data workloads, migration Jobs, database correctness, public
API journeys, tenant isolation, telemetry/projection/alert flows, or iPhone
behavior. Those remain separate acceptance phases.

## Remaining automatic acceptance work

The deployment must run separately scoped migrations/data checks, authenticated
web/API and tenant-isolation journeys, and telemetry-to-projection/alert/ACK
checks. Existing `check-live-acceptance.py` validates a hashed evidence
inventory including physical-iPhone and teardown outcomes; it does not execute
or attest those journeys. Physical-iPhone acceptance needs the real device and
reviewed observations. All live AWS, registry, private endpoint, workload,
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
