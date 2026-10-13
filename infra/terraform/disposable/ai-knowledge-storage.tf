# Knowledge documents are private source material, distinct from telemetry
# archives. The application writes tenant/<tenant>/documents/... objects;
# IAM policies are bound to this bucket by the AI Pod Identity resources.
locals {
  ai_knowledge_bucket_name = "greenguard-${var.target_account_id}-${var.aws_region}-${substr(sha256(var.cluster_name), 0, 12)}-knowledge"
}

resource "aws_kms_key" "ai_knowledge_documents" {
  count                   = var.ai_runtime_enabled ? 1 : 0
  depends_on              = [terraform_data.destroy_inventory_sentinel]
  description             = "Disposable GreenGuard Knowledge source documents for ${var.cluster_name}"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  tags = {
    Name        = "${var.cluster_name}-knowledge-documents"
    Environment = var.environment
    Lifecycle   = "Disposable"
    Cell        = var.cluster_name
    ManagedBy   = "Terraform"
    Purpose     = "KnowledgeDocuments"
  }

  lifecycle {
    precondition {
      condition     = var.ai_runtime_enabled && lower(var.environment) == "disposable" && can(regex("^[0-9]{12}$", var.target_account_id))
      error_message = "Knowledge storage is restricted to an account-qualified disposable cell."
    }
  }
}

resource "aws_s3_bucket" "ai_knowledge_documents" {
  count         = var.ai_runtime_enabled ? 1 : 0
  depends_on    = [terraform_data.destroy_inventory_sentinel]
  bucket        = local.ai_knowledge_bucket_name
  force_destroy = true
  tags = {
    Name        = "${var.cluster_name}-knowledge-documents"
    Environment = var.environment
    Lifecycle   = "Disposable"
    Cell        = var.cluster_name
    ManagedBy   = "Terraform"
    Purpose     = "TenantKnowledgeSourceDocuments"
  }

  lifecycle {
    precondition {
      condition     = var.ai_runtime_enabled && lower(var.environment) == "disposable" && length(local.ai_knowledge_bucket_name) <= 63 && can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", local.ai_knowledge_bucket_name))
      error_message = "Knowledge documents bucket must be a unique valid name in a disposable environment."
    }
  }
}

resource "aws_s3_bucket_public_access_block" "ai_knowledge_documents" {
  count                   = var.ai_runtime_enabled ? 1 : 0
  depends_on              = [terraform_data.destroy_inventory_sentinel]
  bucket                  = aws_s3_bucket.ai_knowledge_documents[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "ai_knowledge_documents" {
  count      = var.ai_runtime_enabled ? 1 : 0
  depends_on = [terraform_data.destroy_inventory_sentinel]
  bucket     = aws_s3_bucket.ai_knowledge_documents[0].id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "ai_knowledge_documents" {
  count      = var.ai_runtime_enabled ? 1 : 0
  depends_on = [terraform_data.destroy_inventory_sentinel]
  bucket     = aws_s3_bucket.ai_knowledge_documents[0].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ai_knowledge_documents" {
  count      = var.ai_runtime_enabled ? 1 : 0
  depends_on = [terraform_data.destroy_inventory_sentinel]
  bucket     = aws_s3_bucket.ai_knowledge_documents[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.ai_knowledge_documents[0].arn
    }
    # Keep the per-object encryption context so IAM can constrain decrypts to
    # tenant document prefixes rather than the whole bucket.
    bucket_key_enabled = false
  }
}

resource "aws_s3_bucket_policy" "ai_knowledge_documents" {
  count  = var.ai_runtime_enabled ? 1 : 0
  bucket = aws_s3_bucket.ai_knowledge_documents[0].id
  depends_on = [
    terraform_data.destroy_inventory_sentinel,
    aws_s3_bucket_public_access_block.ai_knowledge_documents,
  ]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.ai_knowledge_documents[0].arn, "${aws_s3_bucket.ai_knowledge_documents[0].arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

output "ai_knowledge_documents_bucket" {
  description = "Cell-owned encrypted Knowledge source bucket; no object data is returned."
  value       = try(aws_s3_bucket.ai_knowledge_documents[0].id, null)
}

output "ai_knowledge_documents_bucket_arn" {
  description = "Cell-owned Knowledge source bucket ARN for its scoped Pod Identity policies."
  value       = try(aws_s3_bucket.ai_knowledge_documents[0].arn, null)
}

output "ai_knowledge_documents_kms_key_arn" {
  description = "Cell-owned Knowledge source KMS key ARN for the scoped Pod Identity policies."
  value       = try(aws_kms_key.ai_knowledge_documents[0].arn, null)
}
