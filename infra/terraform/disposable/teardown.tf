# Record the cell identity before the first network resource is created. Root
# outputs are written only after a successful apply, so a failed early apply
# must still leave an account-bound scope for verified recovery.
resource "terraform_data" "cell_scope" {
  input = {
    region       = var.aws_region
    environment  = var.environment
    cluster_name = var.cluster_name
    account_id   = var.target_account_id
  }

  lifecycle {
    precondition {
      condition     = !contains(["prod", "production"], lower(var.environment))
      error_message = "The disposable root cannot manage a production environment."
    }
  }
}

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
      condition     = !contains(["prod", "production"], lower(var.environment))
      error_message = "The disposable root cannot manage a production environment."
    }
  }

  input = {
    script       = "${path.module}/pre-destroy.sh"
    pv_inventory = "${path.module}/.last-destroy-pvs"
    cluster      = aws_eks_cluster.cell.name
    region       = var.aws_region
    account      = var.target_account_id
    environment  = var.environment
  }

  depends_on = [
    aws_db_instance.postgres,
    aws_db_instance.shard,
    aws_db_instance.read_replica,
    aws_secretsmanager_secret.shard,
    aws_secretsmanager_secret.shard_routing,
    aws_eks_node_group.general,
    aws_eks_node_group.compute,
    aws_eks_addon.core,
    aws_eks_addon.ebs_csi,
    aws_eks_access_policy_association.cluster_admin,
    aws_route.private_nat,
    aws_route_table_association.private,
    helm_release.argocd,
    helm_release.gitops_bootstrap,
    helm_release.istio_ingressgateway,
    helm_release.aws_load_balancer_controller,
    helm_release.keda,
    helm_release.argo_rollouts,
  ]

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["bash", "-c"]
    command     = "\"$GG_SCRIPT\""
    environment = {
      GG_SCRIPT            = self.input.script
      GG_CLUSTER           = self.input.cluster
      GG_REGION            = self.input.region
      GG_ACCOUNT           = self.input.account
      GG_ENVIRONMENT       = self.input.environment
      GG_PV_INVENTORY_FILE = self.input.pv_inventory
    }
  }
}
