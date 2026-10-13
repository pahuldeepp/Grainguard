# Stage 12.4 — Terraform platform static evidence

Date: 2026-09-26

## Implemented roots

- `infra/terraform/bootstrap-state` creates an operator-named S3 state bucket
  with versioning, SSE-S3, public-access blocking, enforced bucket ownership,
  TLS-only access, and no force destroy.
- `infra/terraform/platform` creates a multi-AZ public/private VPC, per-AZ NAT,
  VPC flow logs, a private-by-default EKS API, EKS audit/control-plane logs,
  KMS envelope encryption for Kubernetes Secrets, EKS access-entry admin,
  managed EKS add-ons (including the Pod Identity Agent), general and tainted
  compute node groups, and immutable ECR repositories for the dashboard and
  all 12 current runtime images with scan-on-push enabled.
- Both roots pin HashiCorp AWS provider v6.60.0 and retain their platform lock
  files. Platform state uses the S3 backend's native lockfile; no DynamoDB lock
  table is created.
- CDK remains a distinct serverless owner. Terraform has not imported or
  duplicated any CDK resource.

## Local verification

- HashiCorp Terraform CLI 1.16.4 downloaded from the official release site and
  verified against its published SHA256SUMS file.
- AWS provider v6.60.0 installed with Terraform's signature verification.
- `terraform fmt -check -recursive infra/terraform` — passed.
- `terraform -chdir=infra/terraform/platform validate` — passed.
- `terraform -chdir=infra/terraform/bootstrap-state validate` — passed.
- A temporary copy of the platform root with the S3 backend removed and
  provider credential checks disabled generated synthetic graph plans: 65
  resources to add with the optional bridge identity disabled, and 68 to add
  with it enabled (both zero to change/destroy). Fake local credentials were
  used; no AWS account call or resource operation occurred. The plans are
  scratch artifacts, not deployable, and do not prove that AZs, EKS version,
  add-on availability, IAM permissions or quotas are valid in an actual account.
- The enabled synthetic plan confirmed the bridge role grants only
  `events:PutEvents` on the supplied EventBridge bus and `sqs:SendMessage` on
  the supplied quarantine queue, bound to namespace `greenguard` and service
  account `eventbridge-bridge`. An empty ARN pair omitted all bridge identity
  resources; a partial pair failed a Terraform precondition.

## Acceptance still open

There are no valid AWS credentials, target account, state bucket, approved
budget or EKS context in this workspace. No remote backend initialization,
authenticated AWS plan, apply, cluster operation or cleanup has occurred.
Managed Postgres/Kafka/cache/search services and registry migration from the
currently used GHCR to Terraform-owned ECR remain incomplete. The compute
nodegroup is statically configured; Karpenter itself is not installed. Stage
12.4 is not complete.
