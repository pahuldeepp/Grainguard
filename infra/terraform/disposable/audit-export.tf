# The audit worker is the only identity allowed to publish exports. The
# control-plane API receives a separate read-only identity solely to HEAD and
# presign tenant-scoped downloads.
locals {
  audit_export_object_arn = "${aws_s3_bucket.audit_exports.arn}/tenants/*/audit-exports/*"
  audit_export_pod_roles  = toset(["audit-export-worker", "tenant-control-plane"])
}

data "aws_prefix_list" "s3" {
  count = var.enable_application_tree ? 1 : 0
  name  = "com.amazonaws.${var.aws_region}.s3"
}

resource "aws_vpc_endpoint" "s3" {
  depends_on        = [terraform_data.destroy_inventory_sentinel]
  count             = var.enable_application_tree ? 1 : 0
  vpc_id            = aws_vpc.cell.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for route in aws_route_table.private : route.id]
  policy            = data.aws_iam_policy_document.audit_export_s3_endpoint[0].json

  tags = {
    Name        = "${var.cluster_name}-audit-export-s3"
    Environment = var.environment
    Lifecycle   = "Disposable"
    Cell        = var.cluster_name
    ManagedBy   = "Terraform"
  }
}

data "aws_iam_policy_document" "audit_export_pod_identity" {
  for_each = var.enable_application_tree ? local.audit_export_pod_roles : toset([])

  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/eks-cluster-arn"
      values   = [aws_eks_cluster.cell.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/kubernetes-namespace"
      values   = ["greenguard"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/kubernetes-service-account"
      values   = [each.key]
    }
  }
}

resource "aws_iam_role" "audit_export" {
  depends_on         = [terraform_data.destroy_inventory_sentinel]
  for_each           = var.enable_application_tree ? local.audit_export_pod_roles : toset([])
  name               = "${substr(var.cluster_name, 0, 40)}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.audit_export_pod_identity[each.key].json
  tags = {
    Environment = var.environment
    Lifecycle   = "Disposable"
    Cell        = var.cluster_name
    ManagedBy   = "Terraform"
    Service     = each.key
  }

  lifecycle {
    precondition {
      condition     = !contains(["prod", "production"], lower(var.environment))
      error_message = "Disposable audit-export Pod Identity roles are forbidden in production environments."
    }
  }
}

resource "aws_iam_role_policy" "audit_export" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each   = var.enable_application_tree ? local.audit_export_pod_roles : toset([])
  name       = "${substr(var.cluster_name, 0, 36)}-${each.key}-audit-exports"
  role       = aws_iam_role.audit_export[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = each.key == "audit-export-worker" ? ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"] : ["s3:GetObject"]
      Resource = local.audit_export_object_arn
    }]
  })
}

resource "aws_eks_pod_identity_association" "audit_export" {
  for_each        = var.enable_application_tree ? local.audit_export_pod_roles : toset([])
  cluster_name    = aws_eks_cluster.cell.name
  namespace       = "greenguard"
  service_account = each.key
  role_arn        = aws_iam_role.audit_export[each.key].arn

  depends_on = [aws_eks_addon.pod_identity_agent, aws_iam_role_policy.audit_export,
    terraform_data.destroy_inventory_sentinel,
  ]
}
