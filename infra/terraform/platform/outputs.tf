output "cluster_name" {
  value = aws_eks_cluster.cell.name
}

output "cluster_endpoint" {
  value     = aws_eks_cluster.cell.endpoint
  sensitive = true
}

output "cluster_certificate_authority_data" {
  value     = aws_eks_cluster.cell.certificate_authority[0].data
  sensitive = true
}

output "private_subnet_ids" {
  value = [for zone in local.az_names : aws_subnet.private[zone].id]
}

output "ecr_repository_urls" {
  value = { for name, repository in aws_ecr_repository.runtime : name => repository.repository_url }
}

output "eventbridge_bridge_pod_identity_role_arn" {
  value       = local.eventbridge_bridge_identity_enabled ? aws_iam_role.eventbridge_bridge[0].arn : null
  description = "Least-privilege EKS Pod Identity role ARN; null until both optional event-bus and quarantine-queue ARNs are configured."
}
