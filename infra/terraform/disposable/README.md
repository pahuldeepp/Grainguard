# Disposable AWS cell

This is the single Terraform root for a temporary GreenGuard AWS cell. It
shares the platform resource definitions through the four `../platform/*.tf`
symlinks, adds optional empty Secrets Manager containers, and keeps its state
locally. The separate S3 state-bootstrap bucket is **not** required for this
profile. Run Terraform only from this directory so all commands use the same
state.

## Start and stop

1. Copy `terraform.tfvars.example` to `terraform.tfvars`. Replace every
   placeholder with the target account ID and region, supported EKS version, two
   availability zones, and an existing operator role ARN. Set `secret_names`
   only for secret containers this cell owns. Do not put secret values in
   Terraform variables or state.
2. Use an AWS identity authorized for the resources in this root. The provider
   checks `target_account_id`; check the region too. Apply creates EKS, EC2
   nodes, NAT gateways, EIPs, ECR repositories, KMS, CloudWatch logs, and optionally
   Secrets Manager secrets. They incur charges while deployed.
3. From this directory run:

   ```sh
   terraform init
   terraform plan
   terraform apply
   ```

4. When finished, from **this same directory and state**, run:

   ```sh
   terraform destroy
   ```

   Destroy first runs `pre-destroy.sh` (from `teardown.tf`) while the cluster
   still exists: it deletes the `GreenGuardServerless-<environment>` CDK stack,
   its two Lambda log groups, Kubernetes ingresses, `LoadBalancer` services
   and PVCs, then waits until
   controller-created load balancers are gone. It needs `aws` and `kubectl`
   on `PATH`, access to the private EKS API, and permissions for the CDK stack.
   It checks the AWS account, refuses `environment = "prod"`, and stops network
   teardown if cleanup fails. Then run

   ```sh
   ./check-teardown.sh <region> <environment> <cluster-name>
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
request, related IAM roles/policies, and any `secret_names` created here.
`pre-destroy.sh` additionally deletes this environment's CDK stack and the
Kubernetes ingress, LoadBalancer service and PVC owners of cloud resources.
It waits for tagged load balancers, while storage deletion requires a separate
post-destroy inventory. Destroy does
**not** include `infra/terraform/bootstrap-state`, another Terraform state,
other AWS resources Kubernetes controllers may create (for example Route 53
records from external-dns), or manually created AWS resources. RDS, Kafka/MSK, Cassandra, WAF, Route 53, and the
complete Stage 12 edge/data stack are not yet implemented in this root.

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
