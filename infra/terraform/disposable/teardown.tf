# Makes `terraform destroy` remove the AWS resources this state cannot see
# before it deletes the cluster and network they depend on:
#   - the CDK serverless stack for this environment (non-prod stacks use DESTROY);
#   - load balancers and volumes created by Kubernetes controllers, which would
#     otherwise block VPC deletion and keep billing.
# Terraform destroys this resource first because it depends on the cluster,
# node groups and NAT routes, so kubectl and the AWS APIs are still reachable.
# If cleanup fails, destroy stops before deleting anything else; fix and rerun.
resource "terraform_data" "pre_destroy_cleanup" {
  lifecycle {
    precondition {
      condition     = var.environment != "prod"
      error_message = "The disposable root cannot manage a prod environment."
    }
  }

  input = {
    script      = "${path.module}/pre-destroy.sh"
    cluster     = aws_eks_cluster.cell.name
    region      = var.aws_region
    account     = var.target_account_id
    environment = var.environment
  }

  depends_on = [
    aws_eks_node_group.general,
    aws_eks_node_group.compute,
    aws_eks_addon.core,
    aws_eks_access_policy_association.cluster_admin,
    aws_route.private_nat,
    aws_route_table_association.private,
  ]

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["bash", "-c"]
    command     = "\"$GG_SCRIPT\""
    environment = {
      GG_SCRIPT      = self.input.script
      GG_CLUSTER     = self.input.cluster
      GG_REGION      = self.input.region
      GG_ACCOUNT     = self.input.account
      GG_ENVIRONMENT = self.input.environment
    }
  }
}
