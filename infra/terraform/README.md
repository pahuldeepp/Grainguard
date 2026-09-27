# infra/terraform

Status: **in progress** — plan-only AWS platform and state-bootstrap roots are
implemented; no AWS credentials or resources are configured in this workspace.

Stages: 12.

Technology: Terraform, AWS.

Responsibility: Platform/network/managed-store and OCI registry ownership.

Terraform owns the shared AWS cell infrastructure. CDK remains the exclusive
owner of its separately named serverless resources in `infra/cdk`; do not
import or recreate those resources here. The first roots are:

- `bootstrap-state/`: versioned, encrypted, private S3 state bucket with TLS
  enforcement. This root starts with local state; migrate and back it up after
  an operator provisions the bucket.
- `platform/`: a private EKS API, multi-AZ VPC with per-AZ NAT, VPC flow logs,
  EKS control-plane audit logs and secret encryption, managed general and
  tainted compute node groups, and immutable/scanned ECR repositories for the
  dashboard and all 12 current runtime service images. The EKS Pod Identity
  Agent add-on is installed; the EventBridge bridge identity is optional and
  becomes active only when both exact bus and quarantine-queue ARNs are set.
- `disposable/`: one local-state root that reuses the platform definitions,
  deletes nonempty ECR repositories, and can own selected Secrets Manager
  containers. Run `terraform init`, `terraform plan`, `terraform apply`, and
  later `terraform destroy` in that same directory. See its
  [shutdown boundary and runbook](disposable/README.md) before applying.

The compute node group is zero-sized initially and tainted with
`greenguard.io/workload-class=compute:NoSchedule`; worker pods need both that
toleration and matching node affinity/selector. The general pool serves normal
APIs. HPA/KEDA and Karpenter are separate Kubernetes add-ons and are not
installed by this Terraform root yet.

The API endpoint is private by default. `cluster_admin_role_arn`, the region,
supported Kubernetes version, AZs, and any approved public-endpoint CIDRs are
operator inputs; do not check credentials or environment tfvars into Git. Three
NAT gateways, EKS, KMS and CloudWatch incur ongoing AWS charges. No `apply` has
been run.

The disposable root is the intended temporary entry point for the current
Terraform-owned cell. Its destroy hook deletes the same-environment CDK stack
and Kubernetes owners of load balancers and volumes before Terraform removes
the cluster and VPC. Other controller-created resources and services not yet
defined here remain outside this workflow; it is not an account-wide zero-bill
switch.

Local static workflow (Terraform 1.16.4 and network access for the pinned AWS
provider are required):

```sh
terraform -chdir=infra/terraform/bootstrap-state init -backend=false
terraform -chdir=infra/terraform/bootstrap-state validate
terraform -chdir=infra/terraform/platform init -backend=false
terraform -chdir=infra/terraform/platform validate
terraform fmt -check -recursive infra/terraform
```

For an operator-owned environment, configure
`infra/terraform/platform/backend.hcl` from the example only after the state
bucket exists, then use `terraform -chdir=infra/terraform/platform init
-backend-config=backend.hcl`. Create a saved plan, review its complete resource
and cost changes, and apply only through the owning change process. Terraform's
S3 backend uses native `.tflock` locking; DynamoDB state locking is not added.
Before state recovery, stop all writers, preserve a copy of the current state,
inspect S3 object versions, restore the chosen prior version, and run a read-only
plan. Never use `force-unlock` unless the recorded lock is confirmed stale and
belongs to this operation.

Remaining 12.4 work includes managed data service ownership, provider-specific
security/network policies, a budgeted cost estimate, S3 state-bootstrap
migration and authenticated AWS plan evidence. Current GHCR image publication
has not yet migrated to the ECR repositories provisioned here.

The optional EventBridge bridge role binds only the `greenguard/eventbridge-bridge`
service account through an EKS Pod Identity association. Its inline policy grants
`events:PutEvents` on one configured event bus and `sqs:SendMessage` on one
configured quarantine queue. Set both `eventbridge_event_bus_arn` and
`bridge_quarantine_queue_arn` in operator-owned tfvars, or leave both empty.
Terraform rejects a partial pair. The association has only been verified in a
synthetic no-credential plan; do not treat that as AWS authorization evidence.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.
