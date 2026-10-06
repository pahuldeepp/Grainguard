#!/usr/bin/env ruby
workflow = File.read(File.expand_path('../../../.github/workflows/promote-ecr.yml', __dir__))
terraform = File.read(File.expand_path('../../terraform/disposable/github-ecr-promotion.tf', __dir__))
inventory = File.read(File.expand_path('../../terraform/disposable/variables.tf', __dir__))

checks = {
  'manual dispatch only' => workflow.include?("workflow_dispatch:") && !workflow.match?(/^\s+(push|pull_request):/),
  'main branch guard' => workflow.include?("github.ref == 'refs/heads/main'"),
  'protected GitHub environment' => workflow.include?("name: greenguard-ecr-promotion"),
  'least privilege workflow permissions' => workflow.include?("actions: read") && workflow.include?("id-token: write"),
  'successful CI source run guard' => workflow.include?(".github/workflows/ci.yml") &&
    workflow.include?("run.get(\"conclusion\") != \"success\"") &&
    workflow.include?("run.get(\"head_branch\") != \"main\""),
  'same-run artifact download' => workflow.include?("run-id: ${{ inputs.release_run_id }}") &&
    workflow.include?("greenguard-release-inputs-${{ steps.source.outputs.source_sha }}"),
  'no static AWS credentials' => !workflow.match?(/secrets\.[A-Z0-9_]*(AWS|ACCESS_KEY|SECRET_ACCESS)/),
  'OIDC trust is exact repository environment' => terraform.include?('repo:pahuldeepp/Grainguard:environment:${local.github_ecr_promotion_environment}'),
  'issuer accepts AWS canonical URL without weakening host equality' => terraform.include?('trimprefix(data.aws_iam_openid_connect_provider.github_actions_ecr_promotion[0].url, "https://") == "token.actions.githubusercontent.com"'),
  'OIDC audience is STS' => terraform.include?('"token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"'),
  'role policy is limited to cell repositories' => terraform.include?('values(aws_ecr_repository.runtime)'),
  'role cannot delete ECR repositories' => !terraform.include?('ecr:DeleteRepository'),
  'workflow and Terraform derive the same cell role' => workflow.include?('gg-ecr-promote-{environment}-{hashlib.sha256(cluster.encode()).hexdigest()[:16]}') &&
    terraform.include?('gg-ecr-promote-${var.environment}-${substr(sha256(var.cluster_name), 0, 16)}'),
  'workflow blocks incomplete CI release coverage before AWS auth' => workflow.include?('terraform_apply_eligible') &&
    workflow.index('refusing AWS promotion') < workflow.index('Request short-lived GitHub OIDC credentials'),
  'workflow keeps missing-source AI explicitly disabled' => workflow.include?('ai_runtime_sources_complete') &&
    workflow.include?('AI runtime must remain disabled until every service source and digest is present') &&
    workflow.include?('platform["ai_runtime_images"]'),
  'workflow derives complete platform ECR inventory' => workflow.include?('platform["images"]') &&
    workflow.include?('platform_repositories'),
  'scorer and platform ECR repositories exist' => inventory.include?('"ml-scoring-synthetic"') &&
    %w[otel-collector prometheus grafana tempo loki pgbouncer kafka-topics kafka-connect connector-registration opensearch cassandra mqtt clickhouse clamav].all? { |name| inventory.include?("\"#{name}\"") }
}

failed = checks.reject { |_name, passed| passed }.keys
abort "ECR promotion workflow guard failures: #{failed.join(', ')}" unless failed.empty?
puts "ECR promotion workflow guards passed (#{checks.length} checks)."
