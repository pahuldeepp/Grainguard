# Immutable image handoff

On a successful `main` CI run, runtime and owner-migration publish jobs build,
scan, sign and verify their immutable digests. The migration job builds the
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
- `release-inputs.tfvars.json` with `gitops_revision`, runtime digests,
  `migration_image_digests`, and both migration tool digests for review before
  Terraform.

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
  release-inputs/release-inputs.tfvars.json ecr-urls.json cell-identity.json ecr-release
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
The platform root provisions dedicated immutable repositories for each owner
migration image and both tools, and its normal destroy removes those
repositories together with runtime repositories. It does not apply Terraform, and it does not
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
