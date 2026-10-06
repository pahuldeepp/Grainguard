variable "ai_runtime_image_digests" {
  description = "CI-published immutable Knowledge, indexer, parser, Advisor, Gateway, usage, MCP and ClamAV images."
  type        = map(string)
  default     = {}
  validation {
    condition = length(var.ai_runtime_image_digests) == 0 || (
      toset(keys(var.ai_runtime_image_digests)) == toset(["knowledge", "indexer", "parser", "advisor", "gateway", "usage", "mcp", "clamav"]) &&
      alltrue([for image in values(var.ai_runtime_image_digests) : can(regex("^[^[:space:]@]+@sha256:[a-f0-9]{64}$", image))])
    )
    error_message = "AI requires exactly eight immutable runtime/scanner image references."
  }
}
variable "ai_runtime_sources_complete" {
  description = "Set only by a release assembler after every required AI runtime source and image is present. Missing-source coverage keeps AI disabled."
  type        = bool
  default     = false
}
variable "ai_provider_models" {
  description = "Explicit supported provider model IDs; do not invent production model names."
  type        = object({ embedding = string, reranker = string, answer = string })
  default     = { embedding = "", reranker = "", answer = "" }
  validation {
    condition     = alltrue([for model in values(var.ai_provider_models) : length(model) <= 256 && !can(regex("[[:space:]]", model))])
    error_message = "Provider model IDs must be bounded nonempty identifiers without whitespace when AI is enabled."
  }
}
variable "ai_external_https_cidrs" {
  description = "Reviewed provider/OIDC/Pinecone/S3 IPv4 egress ranges; broad internet allow-all is rejected by the AI chart."
  type        = list(string)
  default     = []
}
locals {
  ai_gitops_values = {
    enabled                      = var.ai_runtime_enabled
    environment                  = var.environment
    scopeIdentity                = "${var.target_account_id}:${var.aws_region}:${var.environment}:${var.cluster_name}:${var.cluster_name}"
    secretSyncEpoch              = try(terraform_data.ai_secret_sync[0].id, "")
    rdsHost                      = aws_db_instance.postgres.address
    rdsCIDRs                     = [for subnet in aws_subnet.private : subnet.cidr_block]
    externalHTTPSCIDRs           = var.ai_external_https_cidrs
    kubernetesAPICIDRs           = concat(["${cidrhost(aws_eks_cluster.cell.kubernetes_network_config[0].service_ipv4_cidr, 1)}/32"], [for subnet in aws_subnet.private : subnet.cidr_block])
    parserRuntimeClassName       = "greenguard-parser-runsc"
    podIdentityAssociationsReady = var.ai_runtime_enabled && length(aws_eks_pod_identity_association.ai_knowledge) == 2
    knowledgeAPIRoleArn          = try(aws_iam_role.ai_knowledge["knowledge-api"].arn, "")
    knowledgeIndexerRoleArn      = try(aws_iam_role.ai_knowledge["knowledge-indexer"].arn, "")
    images                       = var.ai_runtime_image_digests
    providers = {
      authIssuer            = try(local.oidc_public.issuer, "")
      authAudience          = try(local.oidc_public.audience, "")
      authTokenMode         = try(local.oidc_public.token_mode, "audience")
      authClientIds         = var.identity_mode == "cognito" ? [local.oidc_public.web_client_id, local.oidc_public.mobile_client_id] : []
      authJwksUrl           = try(local.oidc_public.jwks_url, "")
      delegatedIssuer       = "https://${aws_cloudfront_distribution.api.domain_name}/delegated"
      delegatedJwksUrl      = "https://${aws_cloudfront_distribution.api.domain_name}/.well-known/delegated-jwks.json"
      pineconeIndexHost     = var.ai_pinecone_index_host
      voyageUrl             = "https://api.voyageai.com/v1"
      anthropicUrl          = "https://api.anthropic.com/v1"
      embeddingModel        = var.ai_provider_models.embedding
      rerankerModel         = var.ai_provider_models.reranker
      answerModel           = var.ai_provider_models.answer
      s3Bucket              = try(aws_s3_bucket.ai_knowledge_documents[0].id, "")
      s3Region              = var.aws_region
      s3KmsKeyArn           = try(aws_kms_key.ai_knowledge_documents[0].arn, "")
      kafkaBootstrapServers = "kafka.greenguard.svc.cluster.local:29092"
      clamavHost            = "clamav.greenguard.svc.cluster.local"
    }
  }
}
