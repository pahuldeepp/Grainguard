# Disposable Terraform cell: local validation

Date: 2026-09-27. This is configuration validation, not an authenticated AWS
plan, deployment, teardown, or zero-cost certification.

- `terraform -chdir=infra/terraform/disposable init -input=false -lockfile=readonly -no-color` — passed; initialized the local backend and reused pinned `hashicorp/aws` 6.60.0.
- `terraform -chdir=infra/terraform/disposable validate -no-color` — passed with `Success! The configuration is valid.`
- `terraform fmt -check -recursive infra/terraform` — passed.
- `git diff --check -- infra/terraform docs/STAGE_12_PLAN.md` — passed.
- `coderabbit review --uncommitted --include-untracked --dir infra/terraform --agent` — first pass had zero findings; later passes found a stale KMS deletion-window sentence and an overbroad Lambda log-group prefix check. Both were corrected.
- `make verify` — passed on the working tree after Go module metadata for the shared telemetry logging imports was refreshed in the affected services.
- `make coverage` — passed and generated reports after replacing an ignored search-indexer virtual environment whose scripts pointed to an older checkout. Coverage generation passed; this result is not a claim that every individual workspace exceeds 80%.

No AWS credentials or cloud API were used for this validation. The disposable
root has not been applied or destroyed. An authenticated `terraform plan`,
followed by a real apply/destroy and AWS resource inventory, is required to
prove the shutdown path.

## One-command teardown (2026-09-27, later)

`terraform destroy` now runs `pre-destroy.sh` through a destroy-time
`terraform_data` provisioner (`teardown.tf`) before the cluster, nodes and NAT
routes are removed: it deletes the `GreenGuardServerless-<environment>` CDK
stack and its two Lambda log groups, Kubernetes ingresses, `LoadBalancer`
services and PVCs, and waits for
controller-created load balancers to disappear, failing the destroy if they
remain. `check-teardown.sh` lists GreenGuard-tagged leftovers afterwards. The
EKS secrets KMS key now uses a 7-day deletion window in this root.

- `shellcheck infra/terraform/disposable/*.sh` — passed.
- `infra/terraform/disposable/teardown_test.sh` — 8/8 passed with stub `aws`/`kubectl` (prod refusal, wrong-account refusal, CDK/Lambda log cleanup order, no-op, stuck load balancer stops destroy, exact-name log audit, clean and dirty post-destroy checks).
- `hashicorp/terraform:1.16` container: `fmt -check -recursive` passed; `validate` passed for `disposable` and `platform`.
- `make verify` — passed (see above).
- `make coverage` — passed (`Coverage reports ready for SonarQube.`) after `scripts/coverage.mjs` switched to `<venv>/bin/python -m pip|coverage`; the earlier silent failure came from a virtualenv copied from another checkout whose script shebangs pointed there.

Still unproven: no authenticated plan, apply or destroy has run against AWS.
