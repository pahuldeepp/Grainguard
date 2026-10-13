# Local deployment readiness — 2026-10-05

## Verified locally

- `make verify` passed for the repository verification target.
- `make smoke` passed local database-backed smoke checks.
- `make staging` passed with an isolated Docker Compose stack; dashboard, device-service readiness, and telemetry-ingest readiness were checked through the staging gateway.
- `make observability-validate observability-test-rules` passed offline configuration and Prometheus rule checks.
- Terraform formatting and offline validation passed for `bootstrap-state`, `platform`, and `disposable` roots.
- AWS CLI 2.37.9 was installed. `aws login` established a temporary `greenguard` profile; STS confirmed account `580360261589`, assumed role `AccountFullAccessRole`, region `us-east-2`.
- Read-only AWS inventory found no EKS clusters, RDS instances, EC2 instances, NAT gateways, load balancers, ECR repositories, Secrets Manager secrets, or S3 buckets in `us-east-2`; the default VPC and AWS-managed KMS aliases exist.
- An account-specific, read-only Terraform plan evaluated 163 creates and 0 changes/destroys, then failed closed on the missing existing-OIDC configuration and the explicit live-readiness gate. It did not apply resources.
- That live plan also exposed and I fixed two HCL evaluation errors: an unguarded nullable OIDC dashboard attribute and structurally different enabled/disabled ML-synthetic scope objects. Formatting, `terraform validate`, and a second plan confirm those errors are gone.
- Grain Advisor Docker image built. Its full isolated unit suite passed (43 tests), including trace-context privacy/propagation and security checks. The readiness failure/exception case also passed.
- Local Prometheus reached `/-/ready`; 22 scrape targets were configured, but only the Prometheus and PostgreSQL WAL targets were up in this local run. This is not a live cluster observability acceptance.

These checks establish local build, test, and selected staging behavior. They do not prove AWS provisioning, authenticated real-user journeys, physical-iPhone connectivity, multi-node failover, production model validity, or full live data-plane acceptance.

## Deployment blockers remain

- `infra/terraform/disposable/readiness.tf` intentionally fails normal plan/apply while live controller/data-service bootstrap, secrets, migrations, Stage 11 telemetry, tenant enrollment, web/iPhone acceptance, secret sync/rotation, and audit-export acceptance remain unproven. Do not set `allow_incomplete_foundation_plan` to claim readiness.
- GitHub Actions builds and signs release images but does not assume an AWS deployment role or run Terraform apply. ECR promotion is a separate operation; Argo application-tree bootstrap is opt-in and needs reviewed immutable release inputs.
- The first EKS Helm operations require a reachable Kubernetes API and an externally configured cluster-admin role. The default endpoint is private; this machine has no configured VPN/in-VPC runner evidence.
- The current deployed-workload acceptance job covers the PostgreSQL owner-migration gate, not the documented Kafka/Connect, Redis, Cassandra, OpenSearch, ClickHouse, OAuth, web, iPhone, or teardown journeys.
- AWS authentication is now configured locally and the identity is verified. No AWS resources have been created or modified.
- The worktree contains extensive pre-existing changes (349 tracked paths in the current diff, plus untracked paths). No broad commit or push was made, and no AWS resource was created.

## Next required gates

1. Finish code review and scoped integration of the existing worktree; avoid publishing the entire dirty tree as one release.
2. Add an explicit, protected AWS deployment identity and a reviewed release-input workflow, or provide approved local Terraform credentials and the required private API route.
3. Implement and execute the missing live acceptance journeys, resolve the readiness gate only when their evidence is real, and verify the account/environment guards.
4. Only then run normal `terraform plan` and `terraform apply`; validate web and physical-iPhone journeys, then use the verified destroy procedure and final inventory check.

## Current continuation evidence — AWS activation and release preparation

This section supersedes the initial account/policy and readiness descriptions above.

- AWS STS again confirmed account `580360261589`. Advanced activation cleared the inherited IAM OIDC denial. Created and read back the account-level GitHub issuer `token.actions.githubusercontent.com` with STS audience. This shared, nonbillable IAM provider is outside disposable-cell ownership. No Terraform apply or EKS deployment has run.
- GitHub environment `greenguard-ecr-promotion` now restricts deployment branches to `main`. Required-reviewer configuration returned HTTP 422 because the repository plan does not support that protection rule; it is not claimed configured.
- The issuer precondition now accepts the AWS canonical issuer URL with or without `https://`, while requiring exact host equality. The ECR workflow guard suite passes 17 checks. Terraform validation passes.
- A fresh full local `COMPOSE_PROJECT_NAME=greenguard-audit make verify` passed after updating source-map-js to 1.2.2; npm audit reported zero vulnerabilities. The full `make coverage` command subsequently exited 0 and produced reports for SonarQube; this is report-generation evidence, not a remote Sonar quality-gate result.
- The disposable Python suite passes 56 tests, including four-shard credential generation, role matching, credential isolation, idempotence and file-permission checks. Private four-shard and initial managed-Dex credential bundles are outside the repository; the runtime bundle is still incomplete.
- The account-specific plan with shard credentials resolved credential-map blockers, evaluated 243 creates and still failed required image/secret checks. It is not an apply-ready plan. The current readiness resource requires the complete application tree; post-deployment user journeys remain separate acceptance gates.
- Vendor release checks remain open. Cosign verification of the pinned OpenTelemetry digest found no signatures at the Docker Hub source or corresponding GHCR source. Neither scan/signature flags nor release eligibility were changed to hide this.
- The image bootstrap ordering still needs resolution: the promotion role and ECR repositories are owned by the disposable root, while the full application plan requires promoted image digests. No unmanaged billable bootstrap resources have been created.
- CodeRabbit is reviewing the latest issuer correction. Earlier scoped Terraform review was clean; this does not establish review of the complete dirty application tree.

- Prepared private Ed25519 audit signing material and the canonical control-plane lookup token. Configured 87 required secret container names from the current Terraform contract. The expanded plan evaluated 331 creates and correctly rejected the still-incomplete runtime payload set; no apply ran.
