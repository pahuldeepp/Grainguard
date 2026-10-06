# Record the cell identity before the first network resource is created. Root
# outputs are written only after a successful apply, so a failed early apply
# must still leave an account-bound scope for verified recovery.
resource "terraform_data" "cell_scope" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
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
    script                             = "${path.module}/pre-destroy.sh"
    pv_inventory                       = "${path.module}/.last-destroy-pvs"
    manifest                           = "${path.module}/.last-destroy-pvs.scope.json"
    cluster                            = aws_eks_cluster.cell.name
    region                             = var.aws_region
    account                            = var.target_account_id
    environment                        = var.environment
    master_secret_arn                  = aws_db_instance.postgres.master_user_secret[0].secret_arn
    shard_master_secret_arns           = [for database in values(aws_db_instance.shard) : database.master_user_secret[0].secret_arn]
    destroy_inventory_sentinel_enabled = var.enable_disposable_destroy_sentinel
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

    terraform_data.destroy_inventory_sentinel,
    aws_iam_role.alb_controller,
    aws_iam_role_policy.alb_controller,
    aws_eks_pod_identity_association.alb_controller,
    aws_vpc_endpoint.s3,
    aws_iam_role.audit_export,
    aws_iam_role_policy.audit_export,
    aws_eks_pod_identity_association.audit_export,
    aws_dynamodb_table.notification_state,
    aws_vpc_endpoint.dynamodb,
    aws_iam_role.notification_contacts_projector,
    aws_iam_role_policy.notification_contacts_projector,
    aws_eks_pod_identity_association.notification_contacts_projector,
    terraform_data.eks_api_reachability,
    helm_release.istio_base,
    helm_release.istiod,
    helm_release.greenguard_namespace,
    aws_db_subnet_group.postgres,
    aws_security_group.postgres,
    aws_db_parameter_group.postgres,
    aws_s3_bucket.audit_exports,
    aws_s3_bucket_public_access_block.audit_exports,
    aws_s3_bucket_ownership_controls.audit_exports,
    aws_s3_bucket_server_side_encryption_configuration.audit_exports,
    aws_s3_bucket_policy.audit_exports,
    aws_s3_bucket.telemetry_archive,
    aws_s3_bucket_public_access_block.telemetry_archive,
    aws_s3_bucket_ownership_controls.telemetry_archive,
    aws_s3_bucket_server_side_encryption_configuration.telemetry_archive,
    aws_s3_bucket_versioning.telemetry_archive,
    aws_s3_bucket_policy.telemetry_archive,
    aws_iam_role.telemetry_archive,
    aws_iam_role_policy.telemetry_archive,
    aws_eks_pod_identity_association.telemetry_archive,
    aws_iam_role.telemetry_replay,
    aws_iam_role_policy.telemetry_replay,
    aws_eks_pod_identity_association.telemetry_replay,
    aws_iam_role.ai_knowledge,
    aws_iam_role_policy.ai_knowledge,
    aws_eks_pod_identity_association.ai_knowledge,
    aws_iam_role.ebs_csi,
    aws_iam_role_policy_attachment.ebs_csi,
    aws_security_group.edge,
    aws_vpc_security_group_ingress_rule.cloudfront_to_edge,
    aws_vpc_security_group_egress_rule.edge_to_ingress_pods,
    aws_vpc_security_group_egress_rule.edge_to_ingress_health,
    aws_vpc_security_group_ingress_rule.edge_to_ingress_eks_nodes,
    aws_vpc_security_group_ingress_rule.edge_to_ingress_health_eks_nodes,
    aws_lb.edge,
    aws_lb_target_group.mesh_ingress,
    aws_lb_listener.edge,
    aws_cloudfront_vpc_origin.edge,
    aws_wafv2_web_acl.edge,
    aws_cloudfront_cache_policy.static_assets,
    aws_cloudfront_distribution.web,
    aws_cloudfront_distribution.api,
    terraform_data.deployed_workload_acceptance,
    aws_secretsmanager_secret.ml_synthetic,
    aws_secretsmanager_secret_version.ml_synthetic,
    aws_secretsmanager_secret.ai_database_roles,
    aws_secretsmanager_secret_version.ai_database_roles,
    terraform_data.ml_synthetic_contract,
    terraform_data.ml_synthetic_namespace_cleanup,
    terraform_data.ml_synthetic_secret_cleanup,
    terraform_data.ml_synthetic_secret_sync,
    terraform_data.ml_synthetic_secret_guard,
    terraform_data.ai_bundle_guard,
    terraform_data.ai_secret_sync,
    terraform_data.ai_secret_cleanup,
    aws_secretsmanager_secret.ai_runtime,
    aws_secretsmanager_secret_version.ai_runtime,
    terraform_data.public_edge_acceptance,
    aws_iam_role_policy.eks_secrets_encryption,
    aws_iam_role.eventbridge_bridge,
    aws_iam_role_policy.eventbridge_bridge,
    aws_eks_pod_identity_association.eventbridge_bridge,
    terraform_data.identity_contract,
    aws_cognito_user_pool.cell,
    aws_cognito_user_pool_domain.cell,
    aws_cognito_user_pool_client.web,
    aws_cognito_user_pool_client.mobile,
    aws_vpc.cell,
    aws_internet_gateway.cell,
    aws_subnet.public,
    aws_subnet.private,
    aws_route_table.public,
    aws_route.public_internet,
    aws_route_table_association.public,
    aws_eip.nat,
    aws_nat_gateway.az,
    aws_route_table.private,
    aws_cloudwatch_log_group.eks,
    aws_cloudwatch_log_group.vpc_flow,
    aws_iam_role.vpc_flow,
    aws_iam_role_policy.vpc_flow,
    aws_flow_log.cell,
    aws_iam_role.eks_cluster,
    aws_iam_role_policy_attachment.eks_cluster,
    aws_iam_role.eks_nodes,
    aws_iam_role_policy_attachment.eks_nodes,
    aws_kms_key.eks_secrets,
    aws_s3_bucket.ai_knowledge_documents,
    aws_s3_bucket_public_access_block.ai_knowledge_documents,
    aws_s3_bucket_ownership_controls.ai_knowledge_documents,
    aws_s3_bucket_versioning.ai_knowledge_documents,
    aws_s3_bucket_server_side_encryption_configuration.ai_knowledge_documents,
    aws_s3_bucket_policy.ai_knowledge_documents,
    aws_kms_key.ai_knowledge_documents,
    aws_secretsmanager_secret.ai_database_roles,
    aws_secretsmanager_secret_version.ai_database_roles,
    aws_eks_cluster.cell,
    aws_eks_access_entry.cluster_admin,
    aws_eks_addon.pod_identity_agent,
    aws_launch_template.parser,
    aws_eks_node_group.parser,
    helm_release.parser_runtime,
    aws_launch_template.general,
    aws_launch_template.compute,
    aws_ecr_repository.runtime,
    terraform_data.deployment_readiness_gate,
    aws_secretsmanager_secret_version.runtime,
    terraform_data.runtime_secret_sync,
    terraform_data.runtime_secret_cleanup,
    aws_secretsmanager_secret.runtime,
    aws_secretsmanager_secret.argocd_repository,
    aws_secretsmanager_secret_version.argocd_repository,
    terraform_data.argocd_repository_secret_sync,
    terraform_data.argocd_repository_secret_cleanup,
    aws_iam_role.github_actions_ecr_promotion,
    aws_iam_role_policy.github_actions_ecr_promotion,
    aws_secretsmanager_secret_version.shard_routing,
    aws_secretsmanager_secret_version.shard_bootstrap,
    aws_secretsmanager_secret_version.tenant_bootstrap,
    aws_secretsmanager_secret_version.shard_data,
    aws_secretsmanager_secret.projector_routing,
    aws_secretsmanager_secret_version.projector_routing,
    terraform_data.cell_scope,
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
      # Older applied states predate these input fields. Keep those destroy
      # provisioners callable; the wrapper/pre-destroy hook persists an
      # authoritative manifest before Terraform starts deleting resources.
      GG_DESTROY_MANIFEST_FILE              = try(self.input.manifest, "${path.module}/.last-destroy-pvs.scope.json")
      GG_MASTER_SECRET_ARN                  = try(self.input.master_secret_arn, "")
      GG_SHARD_MASTER_SECRET_ARNS           = jsonencode(try(self.input.shard_master_secret_arns, []))
      GG_DESTROY_INVENTORY_SENTINEL_ENABLED = tostring(try(self.input.destroy_inventory_sentinel_enabled, false))
    }
  }
}
