# Immutable image handoff

On a successful `main` CI run, runtime, checked-in AI-runtime and owner-migration publish
jobs build, scan, sign and verify their immutable digests. The platform publish
job builds repository-owned data-plane images and mirrors vendor images only
from digest-pinned references in `platform-image-inventory.json`; it scans and
signs each resulting GHCR digest. The migration job builds the
eleven Dockerfile `migration` targets separately from runtime images, plus the
read-only `kubectl` gate image (from the checksum-pinned Kubernetes 1.37.0
binary) and a PostgreSQL tool image whose base is the exact digest already
used by the RDS bootstrap chart. The `release-inputs` job downloads only
artifacts from that run and checks each exact artifact inventory, revision,
and repository before emitting. The image digests are from the successful
signed publish jobs; the ECR promoter verifies each signature again:

- `images.json` for `resolve-images.rb`;
- `migration-images.json` for the eleven separately built owner migration
  images;
- `release-inputs.tfvars.json` with exact runtime/available-AI/migration digests, both
  migration tools, all five observability images, all four data-plane images,
  OpenSearch, Cassandra, MQTT, ClickHouse and ClamAV;
- `release-coverage.json` with explicit vendor-signature and acceptance-probe
  readiness.

The checked-in AI source inventory contains all seven repository-owned runtime
images: Knowledge API, indexer, parser, Grain Advisor, MCP gateway, model gateway
and usage worker. Their Dockerfiles are present and the CI publish matrix covers
them. The eighth AI image is the digest-pinned ClamAV vendor image. Source
presence does not prove that these images have been published or tested on EKS.
The assembler sets `ai_runtime_sources_complete` only when the exact source and
signed image inventory is complete; Terraform still requires all eight immutable
references, private runtime inputs, reviewed network configuration and live
acceptance. An artifact with AI disabled does not satisfy the full GreenGuard
core + AI/ML deployment goal.

No CI job runs `terraform apply`. The artifact does not set
`enable_application_tree`, supply secrets or enroll users. Those deployment
prerequisites and live AWS acceptance remain blocked by the readiness gate.
The images are hosted in GHCR; EKS pull access must be proven for their actual
package visibility. To use the ECR repositories owned by the disposable
Terraform state, run the explicit promotion after Terraform creates them:

```sh
terraform -chdir=infra/terraform/platform output -json ecr_repository_urls > ecr-urls.json
terraform -chdir=infra/terraform/disposable output -json disposable_cell_identity > cell-identity.json
ruby infra/gitops/disposable/promote-images-to-ecr.rb \
  release-inputs/release-inputs.tfvars.json release-inputs/release-coverage.json \
  ecr-urls.json cell-identity.json ecr-release
```

Run this from the repository root with `aws`, `cosign`, and `skopeo` installed.
The AWS identity must be permitted to push to those ECR repositories; if GHCR
images are private, the operator must provide GHCR read credentials through
the container client's normal authentication file. The promotion script
checks the current AWS account against Terraform's saved account, verifies
each GHCR digest's GitHub Actions signing identity again, copies every
published architecture with digest preservation, and checks ECR's returned digest.
Only after all runtime, migration, kubectl, and PostgreSQL images pass does it
write `ecr-release/release-inputs.tfvars.json` with ECR references for review.
The platform root provisions cell-scoped immutable repositories under
`greenguard/<environment>/cell-<first-16-sha256-of-cluster-name>/` for runtime,
owner migration, and tool images. Destroy removes only repositories in that
cell namespace; older shared `greenguard/<service>` repositories are not owned
by this disposable state. It does not apply Terraform, and it does not
claim the GHCR signature is hosted in ECR. EKS pulls the copied image by the
verified digest. Protect the release inputs and retain the source CI artifact
as provenance evidence.

The ECR repositories are in the platform Terraform state and their
`force_delete` setting removes images on teardown. A later deployment must
still prove node IAM pull access and actual pod startup before opening the
readiness gate.

Run the offline assembler test with
`ruby infra/gitops/disposable/test-assemble-ci-digests.rb`.
Run the AWS-free ECR promotion contract with
`ruby infra/gitops/disposable/test-promote-images-to-ecr.rb`.

## Protected GitHub Actions promotion

After the disposable cell's immutable ECR repositories exist, the
`Promote signed GreenGuard images to ECR` workflow can copy only the release
artifact from a successful `CI` push run on `main`. It checks the source run's
repository, workflow, event, branch, completion state and SHA, downloads the
artifact by that run ID, checks the artifact revision, and runs the same
signature-verifying/digest-preserving promoter. The workflow does not apply
Terraform or deploy to EKS. Its output is a reviewable artifact named
`greenguard-ecr-release-inputs-<environment>-<cluster>-<sha>`.

Before enabling it, an account administrator must configure the GitHub
repository environment `greenguard-ecr-promotion` to allow only the protected
`main` branch and require an approval reviewer. The disposable Terraform cell
does not create or delete the account-shared IAM OIDC provider. Supply its
existing `token.actions.githubusercontent.com` provider ARN and set
`enable_github_actions_ecr_promotion = true`; Terraform validates the issuer,
then creates a cell-scoped role whose trust is limited to this repository and
environment. The role can push and inspect images only in the cell ECR
repositories. It has no static AWS credentials and no delete permissions.

The CI release manifest contains the exact Terraform maps for runtime, available
AI images, observability, data-plane, database and ClamAV images. Acceptance
jobs bind two explicitly named image roles: the ClickHouse server digest for
`clickhouse-client`, and the Node tenant-control-plane digest for the
membership-readback script. The assembler checks the chart's commands and
binds those image references into release coverage.

Promotion remains blocked today. The vendor images are pinned by OCI digest,
but their upstream signatures/provenance have not been verified. The CI
artifact records each outstanding source verification, and the promotion
workflow stops before requesting AWS OIDC credentials while coverage is
blocked. This is intentionally not represented as a ready-to-apply release.

Run `ruby infra/gitops/disposable/test-ecr-promotion-workflow.rb` for the
workflow and trust-policy guard checks.
