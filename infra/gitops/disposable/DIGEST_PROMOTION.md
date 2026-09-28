# Immutable image handoff

On a successful `main` CI run, each image publish job builds, scans, signs and
verifies its image digest. Only then does it upload one `{service}.json`
artifact. The `release-inputs` job downloads artifacts from that run and checks
that every image in `contract.json` has exactly one digest from the same Git
commit and the expected GHCR repository. It publishes:

- `images.json` for `resolve-images.rb`;
- `release-inputs.tfvars.json` with `gitops_revision` and
  `deployment_image_digests` for review before Terraform.

No CI job runs `terraform apply`. The artifact does not set
`enable_application_tree`, supply secrets or enroll users. Those deployment
prerequisites and live AWS acceptance remain blocked by the readiness gate.
The images are hosted in GHCR; EKS pull access must be proven for their actual
package visibility. To use the ECR repositories owned by the disposable
Terraform state, run the explicit promotion after Terraform creates them:

```sh
terraform -chdir=infra/terraform/disposable output -json ecr_repository_urls > ecr-urls.json
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
architecture with digest preservation, and checks ECR's returned digest.
Only after every image in `contract.json` passes does it write `ecr-release/release-inputs.tfvars.json`
with ECR references for review. It does not apply Terraform, and it does not
claim the GHCR signature is hosted in ECR. EKS pulls the copied image by the
verified digest. Protect the release inputs and retain the source CI artifact
as provenance evidence.

The ECR repositories are in the disposable Terraform state and their
`force_delete` setting removes images on teardown. A later deployment must
still prove node IAM pull access and actual pod startup before opening the
readiness gate.

Run the offline assembler test with
`ruby infra/gitops/disposable/test-assemble-ci-digests.rb`.
Run the AWS-free ECR promotion contract with
`ruby infra/gitops/disposable/test-promote-images-to-ecr.rb`.
