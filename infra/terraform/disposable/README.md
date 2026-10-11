# Disposable AWS cell

This is the single Terraform root for a temporary GreenGuard AWS cell. It
shares the platform resource definitions through the four `../platform/*.tf`
symlinks, adds private RDS/S3, CloudFront/WAF/ALB, OIDC configuration and
Secrets Manager containers, and keeps its state locally.
The separate S3 state-bootstrap bucket is **not** required for this
profile. Run Terraform only from this directory so all commands use the same
state.

**Readiness gate:** An apply that omits the Argo application tree is rejected;
this root must not silently create an AWS foundation without GreenGuard. The
tree requires an exact Git revision, digest-pinned image manifests, required
secret inputs and an OIDC provider. Terraform waits for Argo reconciliation and
the configured in-cluster workload/migration acceptance. Web/mobile login,
tenant workflows, live data-service behavior, physical-iPhone use and final
destroy inventory still require their own acceptance evidence.

`defaults.auto.tfvars` selects `identity_mode = "managed-dex"` for this
disposable root, hosting the checked-in Dex design with OIDC + PKCE. To use an
operator-supplied provider, explicitly override `identity_mode = "existing-oidc"`
and supply `existing_oidc`. Cognito requires explicit opt-in. The managed issuer
is the cell's API CloudFront HTTPS hostname under
`/dex`, backed by the central RDS database with certificate verification. Its
first login requires a bcrypt hash and email in the ephemeral
`greenguard-dex-config` runtime payload and a `DEX_DB_PASSWORD` in the central
RDS-bootstrap payload. Dex's local-only demo accounts are never deployed.
Destroy/recreate changes the CloudFront host and issuer; users must authenticate
and enroll again. See [EDGE_IDENTITY.md](EDGE_IDENTITY.md) and the
[first-admin runbook](../../../docs/runbooks/disposable-oidc-first-admin.md).

## Future start and stop workflow

The workflow is runnable only after CI has produced an immutable release
manifest and all required secret/bootstrap inputs are available. Incomplete
configuration fails closed. Successful Terraform health checks do not replace
the live service and user-journey acceptance recorded in the runbook.

1. Copy `terraform.tfvars.example` to `terraform.tfvars`. Replace every
   placeholder with the target account ID and region, supported EKS version, two
   availability zones, and an existing operator role ARN. Terraform derives all
   required Secrets Manager container names from the application contract when
   the application tree is enabled; use `secret_names` only for additional
   cell-owned containers. Also select a region that supports
   CloudFront VPC origins and supply a compatible EBS CSI add-on version.
   Keep `environment = "disposable"`; this root's force-destroy archive
   resources require that exact label, while `cluster_name` may include a
   descriptive name such as `greenguard-sandbox-cell-1`.
   Secret payload inputs are ephemeral and are written by AWS provider
   `secret_string_wo` arguments. They are omitted from Terraform plan/state;
   master-secret rotation tracking uses version metadata only. Never put secret
   values in `terraform.tfvars`, command-line arguments, or saved plans; inject
   them through the approved protected runner environment. Increment the
   corresponding nonsecret `secret_version_counters` key when rotating a
   payload, for example `runtime/device-service-config` or
   `shard-bootstrap/s1`. The mocked no-state fixture verifies a sentinel secret
   does not appear in Terraform output or generated artifacts. The normal
   readiness gate remains closed for live secret synchronization/rotation and
   the other end-to-end acceptance gaps.
   `prepare-shard-runtime-bundle.py --output /private/path/shard-runtime-bundle.json`
   prepares independent credentials for all four operational shards and the
   restricted tenant-bootstrap logins. It derives each service's registry
   password from its exact bootstrap role, excludes central control/billing/Dex
   credentials, and preserves an existing valid bundle without rotating it.
   Keep the owner-only output outside the repository. The protected runner must
   inject its three maps as `TF_VAR_shard_role_passwords`,
   `TF_VAR_shard_registry_passwords`, and `TF_VAR_tenant_bootstrap_passwords`;
   never print the maps or pass their values as command-line arguments.
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
   manifest until a clean inventory passes. For a complete successful apply,
   ordinary `terraform destroy` also runs `pre_destroy_cleanup` first and a
   scope-only inventory sentinel last. The sentinel is a prerequisite of every
   managed resource; an offline graph contract checks that fan-out and that
   cleanup depends on the full resource set. A destroy-provisioner failure
   leaves its resource in state, so the final inventory can be retried.
   Partial applies may not have recorded `pre_destroy_cleanup`; use
   `destroy-verified.sh` for those states because it captures PV/secret scope
   and performs Kubernetes cleanup before Terraform deletes EKS or networking.
   Raw destroy of a partial state without that owner is not proven safe.

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
   same idempotent hook again when it exists in state. For an additional manual
   regional inventory after teardown, run

   ```sh
   ./check-teardown.sh <region> <environment> <cluster-name> <account-id>
   ```

   to list scoped resources that still exist, including resources whose
   Terraform state was lost. A complete raw destroy already runs the native
   final sentinel; this command is an extra check. Review the destroy plan and confirm it.
   Re-run if an AWS dependency causes a partial failure; do not discard the
   state until the remaining resources are removed. `terraform state list`
   should then show no managed resources.

The local `terraform.tfstate` is the inventory Terraform needs to destroy the
cell. Keep it (and a protected backup) until teardown is verified. Losing it
does not delete AWS resources. Do not run `terraform destroy` from
`../platform` or `../bootstrap-state`: those are different states. Do not
apply both `platform` and `disposable` to the same named cell.

The disposable profile sets `delete_nonempty_ecr_on_destroy = true`, allowing
cell-scoped ECR repositories with images to be removed. Repository paths use
`greenguard/<environment>/cell-<cluster-hash>/...`, so destroy owns only images
promoted for this disposable cell; historical/shared `greenguard/<service>`
repositories are deliberately preserved and must not be treated as cell-owned.
It requests immediate deletion
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
post-destroy inventory, which the native sentinel runs for a complete state.
Destroy does
**not** include `infra/terraform/bootstrap-state`, another Terraform state,
other AWS resources Kubernetes controllers may create (for example Route 53
records from external-dns), or manually created AWS resources. Kafka/MSK,
Cassandra, Route 53, and the complete Stage 12 application/data stack are not
yet implemented in this root. The RDS instance still requires databases,
roles, migrations, PgBouncer, CDC grants, and connector deployment.

For a **complete successful apply**, raw `terraform destroy` runs
`pre_destroy_cleanup` before removing the cluster/network. That hook persists
the account/cell scope, primary and shard RDS-managed secret ARNs, and exact
EBS volume IDs in owner-only ignored files. The final inventory sentinel runs
after the managed resources are gone and checks those saved ARNs/volume IDs
alongside the exact cell resources and tagged inventory. It removes the scope
manifest only after a clean inventory; a failure keeps it and the sentinel in
state for a retry.

Use `./destroy-verified.sh` for **partial-state recovery** or when you want its
additional preflight. It recovers the cell identity from Terraform state,
captures all available RDS secret ARNs, checks permissions and AWS inventory
reads before cleanup, then runs Terraform destroy and a final inventory. A
partial apply might not have recorded `pre_destroy_cleanup`, so raw destroy of
that state is not established safe. Keep the Terraform state, the protected
state backup, and any failed-destroy manifests until the final inventory is
clean.

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
