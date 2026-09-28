# Disposable AWS cell

This is the single Terraform root for a temporary GreenGuard AWS cell. It
shares the platform resource definitions through the four `../platform/*.tf`
symlinks, adds private RDS/S3, CloudFront/WAF/ALB, Cognito public OAuth clients
and optional empty Secrets Manager containers, and keeps its state locally.
The separate S3 state-bootstrap bucket is **not** required for this
profile. Run Terraform only from this directory so all commands use the same
state.

**Readiness gate:** This root is still an incomplete application deployment.
Its ordinary `terraform plan` and `terraform apply` intentionally fail with a
deployment-readiness error until controller bootstrap, the remaining data
services, migrations, application releases, real-user enrollment and acceptance
are implemented. The `allow_incomplete_foundation_plan` switch is
only for deliberately inspecting or provisioning incomplete resources;
it is not a full GreenGuard deployment. Leave it unset for normal use.

## Future start and stop workflow

The following workflow is **not runnable as a full deployment yet**. Ordinary
`terraform plan` and `terraform apply` fail the readiness gate today. The gate
also calls out audit-export live acceptance: paid catalog tiers advertise the
feature and the worker, signing-key/S3 path, and scoped identities are
configured, but no live signed upload/download has been proven. Do not
set the incomplete-foundation override for a GreenGuard end-to-end deployment.

1. Copy `terraform.tfvars.example` to `terraform.tfvars`. Replace every
   placeholder with the target account ID and region, supported EKS version, two
   availability zones, and an existing operator role ARN. Set `secret_names`
   only for secret containers this cell owns. Also select a region that supports
   CloudFront VPC origins and supply a compatible EBS CSI add-on version.
   **Do not apply this root yet if the requirement is that secret values never
   enter Terraform state or plans.** The current `aws_secretsmanager_secret_version`
   resources store generated and supplied values in Terraform state; marking
   variables `sensitive` only redacts normal CLI output. The default readiness
   gate now reports this as an unresolved blocker. Refactor secret materialization
   to avoid Terraform state exposure before deployment. Never use the incomplete
   foundation override to bypass that gate.
   For a laptop-run deployment, either connect through a VPN/in-VPC runner to
   the private EKS API, or set `cluster_endpoint_public_access = true` and
   `cluster_endpoint_public_access_cidrs` to your operator's public `/32`
   egress address. The validation rejects all-addresses CIDRs and production.
   Verify `kubectl` connectivity before destroy; the pre-destroy hook refuses
   cleanup before deleting the CDK stack if the EKS API is unreachable.
2. When the missing deployment resources and acceptance gate are complete,
   use an AWS identity authorized for the resources in this root. The provider
   checks `target_account_id`; check the region too. Apply would create EKS, EC2
   nodes, NAT gateways, EIPs, ECR repositories, KMS, CloudWatch logs, and optionally
   Secrets Manager secrets, a private RDS PostgreSQL instance, its RDS-managed
   master secret, and a private audit-export S3 bucket. They incur charges
   while deployed. See [DATA_LAYER.md](DATA_LAYER.md) for initialization and
   migration gates; the new resources are not a complete data plane.
3. From this directory run:

   ```sh
   terraform init
   terraform plan
   terraform apply
   ```

4. When finished, from **this same directory and state**, run:

   ```sh
   ./destroy-verified.sh
   ```

   This wrapper reads region, environment, cluster and account from the
   `disposable_cell_identity` Terraform state output, runs `pre-destroy.sh`
   before `terraform destroy`, then checks the AWS inventory. It exits nonzero
   if any step fails. If an apply stopped before root outputs were saved, it
   recovers the identity from `terraform_data.cell_scope` in the partial
   state. Terraform records that scope before creating the VPC, including
   for failures before EKS exists. Older partial states can recover from the
   exact EKS ARN and tags. Optional
   arguments are accepted only when they match that saved identity exactly.
   Before cleanup it persists the exact cell scope and all available RDS
   master-secret ARNs in owner-only `.last-destroy-pvs.scope.json`. If destroy
   succeeds but the final inventory fails, retry with the same four explicit
   scope arguments; the wrapper accepts the saved manifest only after proving
   the active Terraform state has no managed resources. It retains the
   manifest until a clean inventory passes. Raw `terraform destroy` runs its
   pre-destroy cleanup only if Terraform recorded that hook during apply; a
   failed apply can leave a cluster before the hook enters state. It also
   cannot guarantee a final inventory after all Terraform-managed resources
   are gone. Terraform destroy provisioners fire
   when their own resource is deleted; a future resource omitted from a
   dependency chain could be deleted after a supposed final checker. The
   current destroy provisioner rejects a bare invocation without the exact
   wrapper scope marker. That marker is an operator guard, not a security
   boundary; use the wrapper for the final inventory.

   Verified destroy first checks the final AWS inventory read permissions and
   simulates the hook's CloudFormation and log deletion permissions before any
   mutation. IAM simulation cannot prove permissions controlled by service
   control policies, resource policies, or changed credentials; actual calls
   still fail closed. It then runs `pre-destroy.sh` while the cluster
   still exists: it deletes the `GreenGuardServerless-<environment>` CDK stack,
   its two Lambda log groups, Kubernetes ingresses, `LoadBalancer` services
   disposable data StatefulSets and PVCs, then waits until
   controller-created load balancers are gone. It needs `aws` and `kubectl`
   on `PATH`, access to the private EKS API, and permissions for the CDK stack.
   It checks the AWS account, refuses `environment = "prod"` or `"production"`, and stops network
   teardown if cleanup fails. The Terraform destroy provisioner may run the
   same idempotent hook again when it exists in state. If raw Terraform was used,
   then run

   ```sh
   ./check-teardown.sh <region> <environment> <cluster-name> <account-id>
   ```

   to list anything GreenGuard-tagged that still exists, including resources
   whose Terraform state was lost. Review the destroy plan and confirm it.
   Re-run if an AWS dependency causes a partial failure; do not discard the
   state until the remaining resources are removed. `terraform state list`
   should then show no managed resources.

The local `terraform.tfstate` is the inventory Terraform needs to destroy the
cell. Keep it (and a protected backup) until teardown is verified. Losing it
does not delete AWS resources. Do not run `terraform destroy` from
`../platform` or `../bootstrap-state`: those are different states. Do not
apply both `platform` and `disposable` to the same named cell.

The disposable profile sets `delete_nonempty_ecr_on_destroy = true`, allowing
ECR repositories with images to be removed. It requests immediate deletion
of its Secrets Manager containers (`recovery_window_in_days = 0`). KMS key
deletion is scheduled with the disposable profile's seven-day window;
Terraform destroy cannot make that waiting period disappear.

## Ownership boundary

Only resources in this root's state are removed by its `terraform destroy`.
Today that includes its VPC, subnets, routes, NAT gateways/EIPs, EKS cluster
and managed nodes, ECR repositories, CloudWatch log groups, KMS key deletion
request, related IAM roles/policies, any `secret_names` created here, the
private RDS PostgreSQL instance, audit-export S3 bucket, CloudFront
distributions/VPC origin, WAF ACL, private ALB and Cognito pool/clients/domain.
RDS manages
its own master password in Secrets Manager and [deletes that secret when the
instance is deleted](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html).
`pre-destroy.sh` additionally deletes this environment's CDK stack and the
Kubernetes ingress, LoadBalancer service and PVC owners of cloud resources.
It waits for tagged load balancers, while storage deletion requires a separate
post-destroy inventory. Destroy does
**not** include `infra/terraform/bootstrap-state`, another Terraform state,
other AWS resources Kubernetes controllers may create (for example Route 53
records from external-dns), or manually created AWS resources. Kafka/MSK,
Cassandra, Route 53, and the complete Stage 12 application/data stack are not
yet implemented in this root. The RDS instance still requires databases,
roles, migrations, PgBouncer, CDC grants, and connector deployment.

The verified destroy wrapper captures the RDS-managed primary and shard
master-secret ARNs from Terraform state before deletion. It preserves them in
the mode-0600 ignored `.last-destroy-pvs.scope.json`; keep it until inventory
passes. The pre-destroy hook records exact EBS volume IDs from GreenGuard PVCs
before deleting their owners in ignored `.last-destroy-pvs`; keep that file
until inventory passes. Its
post-destroy inventory queries RDS, RDS manual snapshots, S3, the exact
secret ARN, and those exact EBS IDs in addition to tagged
resources. Direct `terraform destroy` cannot pass the secret ARN to the final
inventory because its state output disappears; use `destroy-verified.sh` for
the strongest one-command teardown evidence.

A `prod` CDK stack retains its data resources on deletion, which is why the
disposable root refuses `prod`. Do not interpret a successful Terraform exit as an account-wide
zero-bill guarantee.

After destroy, check the target account and region for remaining EKS clusters,
NAT gateways/EIPs, load balancers, EBS volumes, ECR repositories, Secrets
Manager secrets, RDS/MSK instances, S3 buckets, CloudWatch log groups, CDK
CloudFormation stacks, and active KMS keys. Check other regions and global
services used by the environment. Resolve remaining resources through their
owning state or service; retain the Terraform state backup until this review
is complete. Billing data can lag resource deletion.

This profile is for a disposable environment. Production state needs a
separate durable backend, recovery policy, and deletion controls.
