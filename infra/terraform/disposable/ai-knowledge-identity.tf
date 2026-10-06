# The Knowledge API uploads tenant-owned source PDFs; the indexer only reads
# them. Neither workload can read the telemetry archive or cross the document
# prefix boundary. Bucket/key ownership lives in ai-knowledge-storage.tf.
locals {
  ai_knowledge_pod_identities = {
    knowledge-api     = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    knowledge-indexer = ["s3:GetObject", "kms:Decrypt"]
  }
}

data "aws_iam_policy_document" "ai_knowledge_pod_identity" {
  for_each = var.enable_application_tree && var.ai_runtime_enabled ? local.ai_knowledge_pod_identities : {}

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

resource "aws_iam_role" "ai_knowledge" {
  depends_on         = [terraform_data.destroy_inventory_sentinel]
  for_each           = var.enable_application_tree && var.ai_runtime_enabled ? local.ai_knowledge_pod_identities : {}
  name               = "${substr(var.cluster_name, 0, 38)}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ai_knowledge_pod_identity[each.key].json
  tags = {
    Environment = var.environment
    Lifecycle   = "Disposable"
    Cell        = var.cluster_name
    ManagedBy   = "Terraform"
    Service     = each.key
  }
}

resource "aws_iam_role_policy" "ai_knowledge" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each   = var.enable_application_tree && var.ai_runtime_enabled ? local.ai_knowledge_pod_identities : {}
  name       = "${substr(var.cluster_name, 0, 34)}-${each.key}-documents"
  role       = aws_iam_role.ai_knowledge[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = [for action in each.value : action if startswith(action, "s3:")]
        Resource = "${aws_s3_bucket.ai_knowledge_documents[0].arn}/tenant/*/documents/*"
      },
      {
        Effect   = "Allow"
        Action   = [for action in each.value : action if startswith(action, "kms:")]
        Resource = aws_kms_key.ai_knowledge_documents[0].arn
        Condition = {
          StringEquals = { "kms:ViaService" = "s3.${var.aws_region}.amazonaws.com" }
          StringLike   = { "kms:EncryptionContext:aws:s3:arn" = "${aws_s3_bucket.ai_knowledge_documents[0].arn}/tenant/*/documents/*" }
        }
      }
    ]
  })
}

resource "aws_eks_pod_identity_association" "ai_knowledge" {
  for_each        = var.enable_application_tree && var.ai_runtime_enabled ? local.ai_knowledge_pod_identities : {}
  cluster_name    = aws_eks_cluster.cell.name
  namespace       = "greenguard"
  service_account = each.key
  role_arn        = aws_iam_role.ai_knowledge[each.key].arn
  depends_on      = [terraform_data.destroy_inventory_sentinel, aws_eks_addon.pod_identity_agent, aws_iam_role_policy.ai_knowledge]
}
