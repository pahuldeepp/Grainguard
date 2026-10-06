locals {
  notification_state_table_name = "${substr(local.data_name_prefix, 0, 42)}-${local.data_name_hash}-notification-state"
}

resource "aws_dynamodb_table" "notification_state" {
  depends_on   = [terraform_data.destroy_inventory_sentinel]
  count        = var.enable_application_tree ? 1 : 0
  name         = local.notification_state_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tenant_id"
  range_key    = "record_key"

  attribute {
    name = "tenant_id"
    type = "S"
  }

  attribute {
    name = "record_key"
    type = "S"
  }

  server_side_encryption { enabled = true }

  deletion_protection_enabled = false

  tags = {
    Project     = "GreenGuard"
    Name        = "${var.cluster_name}-notification-state"
    Environment = var.environment
    Cell        = var.cluster_name
    ManagedBy   = "terraform"
  }

  lifecycle {
    precondition {
      condition     = length(local.notification_state_table_name) <= 255 && can(regex("^[A-Za-z0-9_.-]+$", local.notification_state_table_name))
      error_message = "Notification state DynamoDB table name is invalid."
    }
    precondition {
      condition     = !contains(["prod", "production"], lower(var.environment))
      error_message = "The disposable notification state table is forbidden in production environments."
    }
  }
}

# Gateway endpoint avoids sending DynamoDB traffic through a public NAT path.
# Its policy and the pod role both permit only PutItem to this one table.
resource "aws_vpc_endpoint" "dynamodb" {
  depends_on        = [terraform_data.destroy_inventory_sentinel]
  count             = var.enable_application_tree ? 1 : 0
  vpc_id            = aws_vpc.cell.id
  service_name      = "com.amazonaws.${var.aws_region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for route in aws_route_table.private : route.id]
  policy            = data.aws_iam_policy_document.dynamodb_endpoint[0].json

  tags = { Name = "${var.cluster_name}-dynamodb" }
}

data "aws_iam_policy_document" "dynamodb_endpoint" {
  count = var.enable_application_tree ? 1 : 0
  statement {
    effect    = "Allow"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.notification_state[0].arn]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
  }
}

data "aws_prefix_list" "dynamodb" {
  count = var.enable_application_tree ? 1 : 0
  name  = "com.amazonaws.${var.aws_region}.dynamodb"
}

data "aws_iam_policy_document" "notification_contacts_projector" {
  count = var.enable_application_tree ? 1 : 0
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
      values   = ["notification-contacts-projector"]
    }
  }
}

resource "aws_iam_role" "notification_contacts_projector" {
  depends_on         = [terraform_data.destroy_inventory_sentinel]
  count              = var.enable_application_tree ? 1 : 0
  name               = "${var.cluster_name}-notification-contacts-projector"
  assume_role_policy = data.aws_iam_policy_document.notification_contacts_projector[0].json

  lifecycle {
    precondition {
      condition     = !contains(["prod", "production"], lower(var.environment))
      error_message = "The disposable notification projector role is forbidden in production environments."
    }
  }
}

resource "aws_iam_role_policy" "notification_contacts_projector" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  count      = var.enable_application_tree ? 1 : 0
  name       = "${var.cluster_name}-notification-contacts-write"
  role       = aws_iam_role.notification_contacts_projector[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:PutItem"]
      Resource = aws_dynamodb_table.notification_state[0].arn
    }]
  })
}

resource "aws_eks_pod_identity_association" "notification_contacts_projector" {
  count           = var.enable_application_tree ? 1 : 0
  cluster_name    = aws_eks_cluster.cell.name
  namespace       = "greenguard"
  service_account = "notification-contacts-projector"
  role_arn        = aws_iam_role.notification_contacts_projector[0].arn

  depends_on = [aws_eks_addon.pod_identity_agent, aws_iam_role_policy.notification_contacts_projector,
    terraform_data.destroy_inventory_sentinel,
  ]
}

output "notification_state_table" {
  value = try(aws_dynamodb_table.notification_state[0].name, null)
}
