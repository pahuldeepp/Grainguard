# Endpoint transport permissions remain bounded to owned data prefixes.
# Pod Identity IAM roles independently enforce owner-specific actions.
data "aws_iam_policy_document" "audit_export_s3_endpoint" {
  count = var.enable_application_tree ? 1 : 0
  statement {
    effect  = "Allow"
    actions = ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
    resources = concat(
      [local.audit_export_object_arn, "${aws_s3_bucket.telemetry_archive[0].arn}/telemetry/*"],
      var.ai_runtime_enabled ? ["${aws_s3_bucket.ai_knowledge_documents[0].arn}/tenant/*/documents/*"] : [],
    )
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
  }
  statement {
    effect  = "Allow"
    actions = ["s3:ListBucket"]
    resources = concat(
      [aws_s3_bucket.telemetry_archive[0].arn],
      var.ai_runtime_enabled ? [aws_s3_bucket.ai_knowledge_documents[0].arn] : [],
    )
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = concat(["telemetry/", "telemetry/*"], var.ai_runtime_enabled ? ["tenant/*/documents/*"] : [])
    }
  }
  dynamic "statement" {
    for_each = var.ai_runtime_enabled ? [1] : []
    content {
      effect    = "Allow"
      actions   = ["s3:DeleteObject"]
      resources = ["${aws_s3_bucket.ai_knowledge_documents[0].arn}/tenant/*/documents/*"]
      principals {
        type        = "AWS"
        identifiers = ["*"]
      }
    }
  }
}

