# Canonical telemetry archive for the disposable cell. Runtime writes and
# replay reads are limited to one prefix; deleting the disposable Terraform
# root removes this bucket and its retained objects as part of teardown.
locals {
  telemetry_archive_bucket = "${substr(local.data_name_prefix, 0, max(1, 29 - length(var.aws_region)))}-${local.data_name_hash}-${var.target_account_id}-${var.aws_region}-telemetry"
  telemetry_archive_prefix = "telemetry/"
}

resource "aws_s3_bucket" "telemetry_archive" {
  depends_on    = [terraform_data.destroy_inventory_sentinel]
  count         = var.enable_application_tree ? 1 : 0
  bucket        = local.telemetry_archive_bucket
  force_destroy = true
  tags = {
    Name        = "${var.cluster_name}-telemetry-archive"
    Environment = var.environment
    Lifecycle   = "Disposable"
    Cell        = var.cluster_name
    ManagedBy   = "Terraform"
    Purpose     = "CanonicalTelemetryReplay"
  }

  lifecycle {
    precondition {
      condition     = lower(var.environment) == "disposable" && length(local.telemetry_archive_bucket) <= 63 && can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", local.telemetry_archive_bucket))
      error_message = "The telemetry archive bucket is restricted to the disposable environment and must be a valid account-qualified S3 name."
    }
  }
}

resource "aws_s3_bucket_public_access_block" "telemetry_archive" {
  depends_on              = [terraform_data.destroy_inventory_sentinel]
  count                   = var.enable_application_tree ? 1 : 0
  bucket                  = aws_s3_bucket.telemetry_archive[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "telemetry_archive" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  count      = var.enable_application_tree ? 1 : 0
  bucket     = aws_s3_bucket.telemetry_archive[0].id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "telemetry_archive" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  count      = var.enable_application_tree ? 1 : 0
  bucket     = aws_s3_bucket.telemetry_archive[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    bucket_key_enabled = false
  }
}

resource "aws_s3_bucket_versioning" "telemetry_archive" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  count      = var.enable_application_tree ? 1 : 0
  bucket     = aws_s3_bucket.telemetry_archive[0].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_policy" "telemetry_archive" {
  depends_on = [
    terraform_data.destroy_inventory_sentinel,
    aws_s3_bucket_public_access_block.telemetry_archive,
  ]
  count  = var.enable_application_tree ? 1 : 0
  bucket = aws_s3_bucket.telemetry_archive[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.telemetry_archive[0].arn, "${aws_s3_bucket.telemetry_archive[0].arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

data "aws_iam_policy_document" "telemetry_archive_pod_identity" {
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
      values   = ["telemetry-s3-archive"]
    }
  }
}

resource "aws_iam_role" "telemetry_archive" {
  depends_on         = [terraform_data.destroy_inventory_sentinel]
  count              = var.enable_application_tree ? 1 : 0
  name               = "${substr(var.cluster_name, 0, 38)}-telemetry-archive"
  assume_role_policy = data.aws_iam_policy_document.telemetry_archive_pod_identity[0].json
  tags = {
    Environment = var.environment
    Lifecycle   = "Disposable"
    Cell        = var.cluster_name
    ManagedBy   = "Terraform"
    Service     = "telemetry-s3-archive"
  }
}

resource "aws_iam_role_policy" "telemetry_archive" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  count      = var.enable_application_tree ? 1 : 0
  name       = "${substr(var.cluster_name, 0, 34)}-telemetry-archive"
  role       = aws_iam_role.telemetry_archive[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.telemetry_archive[0].arn,
      Condition = { StringLike = { "s3:prefix" = [local.telemetry_archive_prefix, "${local.telemetry_archive_prefix}*"] } } },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      Resource = "${aws_s3_bucket.telemetry_archive[0].arn}/${local.telemetry_archive_prefix}*" }
    ]
  })
}

resource "aws_eks_pod_identity_association" "telemetry_archive" {
  count           = var.enable_application_tree ? 1 : 0
  cluster_name    = aws_eks_cluster.cell.name
  namespace       = "greenguard"
  service_account = "telemetry-s3-archive"
  role_arn        = aws_iam_role.telemetry_archive[0].arn
  depends_on      = [terraform_data.destroy_inventory_sentinel, aws_eks_addon.pod_identity_agent, aws_iam_role_policy.telemetry_archive]
}

output "telemetry_archive_bucket" {
  description = "Disposable encrypted S3 archive bucket for Kafka telemetry replay."
  value       = var.enable_application_tree ? aws_s3_bucket.telemetry_archive[0].id : null
}

# Replay is an operator-invoked workload with read-only archive access. It
# uses a separate Kafka principal with write-only telemetry-topic ACLs.
data "aws_iam_policy_document" "telemetry_replay_pod_identity" {
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
      values   = ["telemetry-replay"]
    }
  }
}

resource "aws_iam_role" "telemetry_replay" {
  depends_on         = [terraform_data.destroy_inventory_sentinel]
  count              = var.enable_application_tree ? 1 : 0
  name               = "${substr(var.cluster_name, 0, 34)}-telemetry-replay"
  assume_role_policy = data.aws_iam_policy_document.telemetry_replay_pod_identity[0].json
  tags = {
    Environment = var.environment
    Lifecycle   = "Disposable"
    Cell        = var.cluster_name
    ManagedBy   = "Terraform"
    Service     = "telemetry-replay"
  }
}

resource "aws_iam_role_policy" "telemetry_replay" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  count      = var.enable_application_tree ? 1 : 0
  name       = "${substr(var.cluster_name, 0, 34)}-telemetry-replay"
  role       = aws_iam_role.telemetry_replay[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.telemetry_archive[0].arn,
      Condition = { StringLike = { "s3:prefix" = [local.telemetry_archive_prefix, "${local.telemetry_archive_prefix}*"] } } },
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.telemetry_archive[0].arn}/${local.telemetry_archive_prefix}*" }
    ]
  })
}

resource "aws_eks_pod_identity_association" "telemetry_replay" {
  count           = var.enable_application_tree ? 1 : 0
  cluster_name    = aws_eks_cluster.cell.name
  namespace       = "greenguard"
  service_account = "telemetry-replay"
  role_arn        = aws_iam_role.telemetry_replay[0].arn
  depends_on      = [terraform_data.destroy_inventory_sentinel, aws_eks_addon.pod_identity_agent, aws_iam_role_policy.telemetry_replay]
}
