# Dedicated sandbox nodes are owned by the disposable cell. A chart runtime
# gate must actually execute an approved parser Pod before AI workloads start.
resource "aws_launch_template" "parser" {
  count                  = var.ai_runtime_enabled ? 1 : 0
  name_prefix            = "${var.cluster_name}-parser-"
  user_data              = base64encode(file("${path.module}/parser-node-user-data.tpl"))
  update_default_version = true
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 40
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }
  depends_on = [terraform_data.destroy_inventory_sentinel]
}
resource "aws_eks_node_group" "parser" {
  count           = var.ai_runtime_enabled ? 1 : 0
  cluster_name    = aws_eks_cluster.cell.name
  node_group_name = "${var.cluster_name}-parser"
  node_role_arn   = aws_iam_role.eks_nodes.arn
  subnet_ids      = [for zone in local.az_names : aws_subnet.private[zone].id]
  instance_types  = ["m6i.large"]
  ami_type        = "AL2023_x86_64_STANDARD"
  capacity_type   = "ON_DEMAND"
  scaling_config {
    min_size     = 1
    desired_size = 1
    max_size     = 2
  }
  update_config { max_unavailable = 1 }
  launch_template {
    id      = aws_launch_template.parser[0].id
    version = aws_launch_template.parser[0].latest_version
  }
  labels = { "greenguard.io/workload-class" = "parser" }
  taint {
    key    = "greenguard.io/workload-class"
    value  = "parser"
    effect = "NO_SCHEDULE"
  }
  depends_on = [aws_iam_role_policy_attachment.eks_nodes, terraform_data.destroy_inventory_sentinel]
}
resource "helm_release" "parser_runtime" {
  count      = var.ai_runtime_enabled ? 1 : 0
  name       = "greenguard-parser-runtime"
  namespace  = "greenguard"
  chart      = "${path.module}/../../gitops/disposable/parser-runtime-chart"
  atomic     = true
  wait       = true
  timeout    = 600
  values     = [yamlencode({ cell = var.cluster_name })]
  depends_on = [terraform_data.destroy_inventory_sentinel, aws_eks_node_group.parser, helm_release.greenguard_namespace, aws_eks_access_policy_association.cluster_admin]
}
