resource "aws_iam_role_policy" "eks_secrets_encryption" {
  name = "${var.cluster_name}-eks-secrets-encryption"
  role = aws_iam_role.eks_cluster.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "kms:CreateGrant",
        "kms:Decrypt",
        "kms:DescribeKey",
        "kms:Encrypt",
        "kms:GenerateDataKey*",
        "kms:ReEncrypt*",
      ]
      Resource = aws_kms_key.eks_secrets.arn
    }]
  })
}

data "aws_iam_policy_document" "eventbridge_bridge_pod_identity" {
  count = local.eventbridge_bridge_identity_enabled ? 1 : 0

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
      values   = ["eventbridge-bridge"]
    }
  }
}

resource "aws_iam_role" "eventbridge_bridge" {
  count              = local.eventbridge_bridge_identity_enabled ? 1 : 0
  name               = "${var.cluster_name}-eventbridge-bridge"
  assume_role_policy = data.aws_iam_policy_document.eventbridge_bridge_pod_identity[0].json
}

resource "aws_iam_role_policy" "eventbridge_bridge" {
  count = local.eventbridge_bridge_identity_enabled ? 1 : 0
  name  = "${var.cluster_name}-eventbridge-bridge-delivery"
  role  = aws_iam_role.eventbridge_bridge[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["events:PutEvents"]
        Resource = var.eventbridge_event_bus_arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = var.bridge_quarantine_queue_arn
      },
    ]
  })
}

resource "aws_eks_pod_identity_association" "eventbridge_bridge" {
  count = local.eventbridge_bridge_identity_enabled ? 1 : 0

  cluster_name    = aws_eks_cluster.cell.name
  namespace       = "greenguard"
  service_account = "eventbridge-bridge"
  role_arn        = aws_iam_role.eventbridge_bridge[0].arn

  depends_on = [aws_eks_addon.pod_identity_agent]
}
