# Apply-time edge verification uses only public cell identity/URL/ARN values.
# The adapter is deliberately after workload readiness and is bounded to ten
# minutes; it does not contain credentials or perform authenticated journeys.
locals {
  public_edge_acceptance_input = {
    cell_identity = {
      account_id   = var.target_account_id
      region       = var.aws_region
      environment  = var.environment
      cluster_name = var.cluster_name
    }
    target_group_arn          = aws_lb_target_group.mesh_ingress.arn
    dashboard_url             = "https://${aws_cloudfront_distribution.web.domain_name}"
    api_url                   = "https://${aws_cloudfront_distribution.api.domain_name}/graphql"
    dashboard_distribution_id = aws_cloudfront_distribution.web.id
    api_distribution_id       = aws_cloudfront_distribution.api.id
    timeout_seconds           = 600
  }
}

resource "terraform_data" "public_edge_acceptance" {
  count = var.enable_application_tree ? 1 : 0

  input = local.public_edge_acceptance_input
  triggers_replace = [
    jsonencode(local.public_edge_acceptance_input),
    try(terraform_data.deployed_workload_acceptance[0].id, ""),
  ]

  depends_on = [
    terraform_data.deployed_workload_acceptance,
    terraform_data.destroy_inventory_sentinel,
  ]

  provisioner "local-exec" {
    command = "python3 ${path.module}/../../gitops/disposable/run-public-edge.py"
    environment = {
      GG_PUBLIC_EDGE_CELL_IDENTITY             = jsonencode(self.input.cell_identity)
      GG_PUBLIC_EDGE_TARGET_GROUP_ARN          = self.input.target_group_arn
      GG_PUBLIC_EDGE_DASHBOARD_URL             = self.input.dashboard_url
      GG_PUBLIC_EDGE_API_URL                   = self.input.api_url
      GG_PUBLIC_EDGE_DASHBOARD_DISTRIBUTION_ID = self.input.dashboard_distribution_id
      GG_PUBLIC_EDGE_API_DISTRIBUTION_ID       = self.input.api_distribution_id
      GG_PUBLIC_EDGE_TIMEOUT_SECONDS           = tostring(self.input.timeout_seconds)
    }
    quiet = true
  }
}
