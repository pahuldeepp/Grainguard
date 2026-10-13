#!/usr/bin/env ruby
# Offline contract for the disposable cell's costly-resource lifecycle.
# This checks source contracts, not AWS behavior. Run from any directory.
require 'json'

module LifecycleAudit
ROOT = File.expand_path(__dir__)
module_function
def source(name)
  @sources ? @sources.fetch(name) : File.read(File.join(ROOT, name))
end

def strip_hcl_comments(text)
  output = +''
  index = 0
  quoted = false
  escaped = false
  block_comment = false
  while index < text.length
    pair = text[index, 2]
    char = text[index]
    if block_comment
      if pair == '*/'
        block_comment = false
        index += 2
      else
        output << "\n" if char == "\n"
        index += 1
      end
    elsif quoted
      output << char
      if escaped
        escaped = false
      elsif char == '\\'
        escaped = true
      elsif char == '"'
        quoted = false
      end
      index += 1
    elsif char == '"'
      quoted = true
      output << char
      index += 1
    elsif char == '#' || pair == '//'
      index += (char == '#' ? 1 : 2)
      index += 1 while index < text.length && text[index] != "\n"
    elsif pair == '/*'
      block_comment = true
      index += 2
    else
      output << char
      index += 1
    end
  end
  output
end

def require_contract(findings, id, file, *markers)
  body = source(file)
  missing = markers.reject { |marker| body.include?(marker) }
  findings << { id: id, file: file, missing: missing } unless missing.empty?
end

# Every AWS resource in this root must be visible to teardown inventory or be
# explicitly classified as a non-metered supporting object. Keep this list
# deliberately exhaustive: adding a new AWS resource type must make its
# inventory strategy explicit in review.
TAG_INVENTORY_TYPES = %w[
  aws_cloudfront_distribution aws_cloudfront_vpc_origin aws_cloudwatch_log_group
  aws_cognito_user_pool aws_cognito_user_pool_domain
  aws_db_instance aws_db_parameter_group aws_db_subnet_group aws_dynamodb_table
  aws_ecr_repository aws_eip aws_eks_addon aws_eks_cluster aws_eks_node_group
  aws_iam_role aws_internet_gateway aws_kms_key aws_lb aws_lb_target_group
  aws_nat_gateway aws_s3_bucket aws_secretsmanager_secret aws_security_group
  aws_subnet aws_vpc aws_vpc_endpoint aws_wafv2_web_acl aws_route_table
  aws_sqs_queue aws_cloudwatch_event_rule aws_iam_instance_profile
].freeze

DIRECT_INVENTORY_MARKERS = {
  'aws_cloudfront_distribution' => 'cloudfront list-distributions',
  'aws_cloudfront_vpc_origin' => 'cloudfront list-vpc-origins',
  'aws_cloudwatch_log_group' => 'logs describe-log-groups',
  'aws_cognito_user_pool' => 'cognito-idp list-user-pools',
  'aws_cognito_user_pool_domain' => 'cognito-idp describe-user-pool-domain',
  'aws_db_instance' => 'rds describe-db-instances',
  'aws_dynamodb_table' => 'dynamodb describe-table',
  'aws_eip' => 'ec2 describe-addresses',
  'aws_eks_cluster' => 'eks list-clusters',
  'aws_internet_gateway' => 'ec2 describe-internet-gateways',
  'aws_lb' => 'elbv2 describe-load-balancers',
  'aws_nat_gateway' => 'ec2 describe-nat-gateways',
  'aws_s3_bucket' => 's3api list-buckets',
  'aws_vpc' => 'ec2 describe-vpcs',
  'aws_wafv2_web_acl' => 'wafv2 list-web-acls',
  'aws_sqs_queue' => 'sqs list-queues',
  'aws_cloudwatch_event_rule' => 'events list-rules',
  'aws_iam_instance_profile' => 'iam list-instance-profiles'
}.freeze

SUPPORTING_RESOURCE_TYPES = %w[
  aws_cloudfront_cache_policy aws_cognito_user_pool_client aws_eks_access_entry
  aws_eks_access_policy_association aws_eks_pod_identity_association
  aws_flow_log aws_iam_role_policy aws_iam_role_policy_attachment
  aws_lb_listener aws_launch_template aws_route aws_route_table_association
  aws_s3_bucket_ownership_controls aws_s3_bucket_policy
  aws_s3_bucket_public_access_block aws_s3_bucket_server_side_encryption_configuration
  aws_s3_bucket_versioning
  aws_secretsmanager_secret_version aws_vpc_security_group_egress_rule
  aws_vpc_security_group_ingress_rule
  aws_sqs_queue_policy aws_cloudwatch_event_target aws_ec2_tag
].freeze

def aws_resource_inventory_gaps(sources = nil)
  terraform_files = if sources
    sources.keys.select { |name| name.end_with?('.tf') && name != 'scope_override.tf' }
  else
    Dir.glob(File.join(ROOT, '*.tf')).map { |path| File.basename(path) }.reject { |name| name == 'scope_override.tf' }
  end
  declared = terraform_files.flat_map do |file|
    strip_hcl_comments(source(file)).scan(/\bresource\s+"(aws_[^"]+)"\s+"[^"]+"/).flatten
  end.uniq
  classified = TAG_INVENTORY_TYPES + SUPPORTING_RESOURCE_TYPES
  gaps = declared - classified
  check = source('check-teardown.sh')
  gaps.concat(TAG_INVENTORY_TYPES.reject do |type|
    marker = DIRECT_INVENTORY_MARKERS[type]
    marker ? check.include?(marker) : true
  end)
  if declared.any? { |type| TAG_INVENTORY_TYPES.include?(type) }
    versions = source('versions.tf')
    check_marker = 'project_resources="$(tagged Key=Project,Values=GreenGuard "Key=Environment,Values=$environment")"'
    unless versions.include?('default_tags') && check.include?(check_marker)
      gaps.concat(declared & TAG_INVENTORY_TYPES)
    end
  end
  gaps.uniq.sort
end

# Source-level destroy graph contract. Terraform reverses dependency edges on
# destroy, so every managed object must depend on the scope-only sentinel, and
# pre_destroy_cleanup must depend on every other object. The latter makes the
# cleanup hook run first; the sentinel's destroy hook then runs last.
def destroy_anchor_graph_findings(sources = nil)
  previous_sources = @sources
  @sources = sources if sources
  terraform_files = if sources
    sources.keys.select { |name| name.end_with?('.tf') && name != 'scope_override.tf' }
  else
    Dir.glob(File.join(ROOT, '*.tf')).map { |path| File.basename(path) }.reject { |name| name == 'scope_override.tf' }
  end
  blocks = terraform_files.flat_map do |file|
    body = strip_hcl_comments(source(file))
    body.to_enum(:scan, /^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/).map do
      match = Regexp.last_match
      start = match.end(0)
      finish = body.index(/^\}/, start)
      finish && ["#{match[1]}.#{match[2]}", body[start...finish]]
    end.compact
  end
  anchor = blocks.select { |label, _| label == 'terraform_data.destroy_inventory_sentinel' }
  return ['missing_or_duplicate_anchor'] unless anchor.length == 1

  issues = []
  anchor_body = anchor.first.last
  input = anchor_body[/\binput\s*=\s*\{(.*?)^\s*\}/m, 1].to_s
  issues << 'anchor_input_has_resource_reference' if input.match?(/\b(?:aws_[a-z0-9_]+|terraform_data|helm_release)\.[A-Za-z0-9_-]+/)
  issues << 'anchor_has_create_before_destroy' if anchor_body.match?(/create_before_destroy\s*=\s*true/)
  blocks.each do |label, body|
    next if label == 'terraform_data.destroy_inventory_sentinel'
    depends = strip_hcl_comments(body[/\bdepends_on\s*=\s*\[(.*?)\]/m, 1].to_s)
    issues << "missing_sentinel_edge:#{label}" unless depends.match?(/\bterraform_data\.destroy_inventory_sentinel\b/)
    issues << "create_before_destroy:#{label}" if body.match?(/create_before_destroy\s*=\s*true/)
  end
  cleanup = blocks.select { |label, _| label == 'terraform_data.pre_destroy_cleanup' }
  return issues + ['missing_or_duplicate_pre_cleanup'] unless cleanup.length == 1
  depends = strip_hcl_comments(cleanup.first.last[/\bdepends_on\s*=\s*\[(.*?)\]/m, 1].to_s)
  blocks.each do |label, _|
    next if %w[terraform_data.destroy_inventory_sentinel terraform_data.pre_destroy_cleanup].include?(label)
    issues << "pre_cleanup_missing_edge:#{label}" unless depends.match?(/\b#{Regexp.escape(label)}\b/)
  end
  issues
ensure
  @sources = previous_sources
end

def findings(sources = nil)
  @sources = sources
  findings = []
  inventory_gaps = aws_resource_inventory_gaps(sources)
  findings << { id: 'aws_resource_inventory_coverage', file: 'check-teardown.sh',
                missing: inventory_gaps } unless inventory_gaps.empty?
  require_contract(findings, 'account_guard', 'versions.tf', 'allowed_account_ids = [var.target_account_id]', 'backend "local"')
  require_contract(findings, 'production_guard', 'pre-destroy.sh', 'production', 'actual_account="$(aws sts get-caller-identity')
  require_contract(findings, 'legacy_destroy_guard', 'pre-destroy.sh',
                   'this state has no final-inventory sentinel', 'expected_verified_scope')
  require_contract(findings, 'network_ownership', 'main.tf', 'resource "aws_vpc" "cell"', 'resource "aws_nat_gateway" "az"', 'resource "aws_eip" "nat"')
  require_contract(findings, 'rds_deletion', 'data-storage.tf', 'skip_final_snapshot         = true', 'delete_automated_backups    = true', 'deletion_protection         = false')
  require_contract(findings, 'secret_deletion', 'secrets.tf', 'recovery_window_in_days = 0')
  unless strip_hcl_comments(source('defaults.auto.tfvars')).match?(/^\s*delete_nonempty_ecr_on_destroy\s*=\s*true\s*$/)
    findings << { id: 'ecr_deletion', file: 'defaults.auto.tfvars', missing: ['delete_nonempty_ecr_on_destroy = true'] }
  end
  require_contract(findings, 'kms_deletion', 'main.tf', 'deletion_window_in_days = var.kms_deletion_window_days')
  require_contract(findings, 'cognito_deletion', 'identity.tf', 'deletion_protection      = "INACTIVE"')
  require_contract(findings, 'edge_ownership', 'edge.tf', 'resource "aws_lb" "edge"', 'resource "aws_cloudfront_distribution" "web"', 'resource "aws_cloudfront_distribution" "api"', 'resource "aws_wafv2_web_acl" "edge"')
  require_contract(findings, 'kubernetes_cleanup', 'pre-destroy.sh', 'k delete applications.argoproj.io', 'k delete ingress', 'k delete pvc', 'tagged_load_balancers')
  # Karpenter creates EC2 capacity outside Terraform state; both the cleanup
  # and the final inventory must address it from the AWS API.
  require_contract(findings, 'karpenter_cleanup', 'pre-destroy.sh', 'k delete nodepools.karpenter.sh --all', 'k delete nodeclaims.karpenter.sh --all',
                   'aws ec2 terminate-instances', 'Karpenter instances still present after', 'aws ec2 delete-launch-template',
                   'Name=tag-key,Values=karpenter.sh/nodepool')
  require_contract(findings, 'karpenter_inventory', 'check-teardown.sh', 'aws ec2 describe-instances', 'Name=tag-key,Values=karpenter.sh/nodepool',
                   'aws ec2 describe-launch-templates', 'Karpenter-launched EC2 instances not terminated', 'Karpenter launch templates')
  require_contract(findings, 'karpenter_destroy_order', 'karpenter.tf', 'resource "helm_release" "karpenter_nodepools"', 'helm_release.karpenter,',
                   'resource "aws_iam_instance_profile" "karpenter_node"')
  require_contract(findings, 'cdk_cleanup', 'pre-destroy.sh', 'aws cloudformation delete-stack', 'aws cloudformation wait stack-delete-complete')
  require_contract(findings, 'post_inventory', 'destroy-verified.sh', '"$here/check-teardown.sh"')
  require_contract(findings, 'pv_inventory', 'check-teardown.sh', 'GreenGuard EBS volume from saved PV', 'PV inventory unavailable; exact untagged EBS proof cannot pass')
  require_contract(findings, 'rds_master_secret_inventory', 'check-teardown.sh', 'RDS-managed master secret still exists')
  require_contract(findings, 'global_edge_inventory', 'check-teardown.sh', 'aws cloudfront list-distributions', 'aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1')
  require_contract(findings, 'kms_pending_inventory', 'check-teardown.sh', 'PendingDeletion')

  # Ignore full-line comments: documentation cannot substitute for executable contracts.
  code = ->(file) { source(file).lines.reject { |line| line.lstrip.start_with?('#') }.join }
  wrapper = code.call('destroy-verified.sh')
  pre = code.call('pre-destroy.sh')
  teardown = code.call('teardown.tf')
  inventory = code.call('check-teardown.sh')
  ordered = lambda do |body, *steps|
    positions = steps.map { |step| body.index(step) }
    positions.none?(&:nil?) && positions.each_cons(2).all? { |a, b| a < b }
  end
  contracts = {
    'native_post_inventory' => ['main.tf',
      code.call('main.tf').include?('resource "terraform_data" "destroy_inventory_sentinel"') &&
      code.call('main.tf').include?('post-destroy-inventory.sh')],
    'partial_apply_recovery' => ['destroy-verified.sh',
      ordered.call(wrapper, '"$here/pre-destroy.sh"', '"$terraform_bin" destroy', '"$here/check-teardown.sh"')],
    'post_inventory_fail_closed' => ['post-destroy-inventory.sh',
      code.call('post-destroy-inventory.sh').include?('destroy-scope-manifest.py" read') &&
      code.call('post-destroy-inventory.sh').include?('check-teardown.sh') &&
      code.call('post-destroy-inventory.sh').include?('saved scope differs from the sentinel state') &&
      ordered.call(code.call('post-destroy-inventory.sh'), 'check-teardown.sh', 'destroy-scope-manifest.py" remove')],
    'partial_apply_before_eks' => ['destroy-verified.sh',
      code.call('scope_override.tf').include?('Name        = "${terraform_data.cell_scope.output.cluster_name}-vpc"') &&
      wrapper.include?('"$terraform_bin" show -json') &&
      wrapper.include?('if r.get("address") == "terraform_data.cell_scope"') &&
      wrapper.include?('if scopes:') && wrapper.include?('if [ "$parse_status" -ne 42 ]; then')],
    'partial_destroy_owner_preflight' => ['pre-destroy.sh',
      ordered.call(pre, 'production', 'actual_account="$(aws sts get-caller-identity',
        '/check-teardown.sh" --preflight', 'aws iam simulate-principal-policy', 'k delete applications.argoproj.io') &&
      ordered.call(pre, 'k get crd nodepools.karpenter.sh', 'aws iam simulate-principal-policy', 'k delete applications.argoproj.io',
        'k delete pvc', 'k delete nodepools.karpenter.sh --all', 'aws ec2 terminate-instances', 'tagged_load_balancers()') &&
      pre.include?('if [ -n "$denied" ] && [ "$denied" != None ]; then') &&
      ordered.call(inventory, 'production', 'actual_account="$(aws sts get-caller-identity', 'aws ec2')],
    'verified_destroy_order' => ['destroy-verified.sh',
      wrapper.include?('set -euo pipefail') &&
      ordered.call(wrapper, 'production', '"$here/pre-destroy.sh"',
        '"$terraform_bin" destroy', '"$here/check-teardown.sh"')],
    'legacy_cleanup_input_compatibility' => ['teardown.tf',
      teardown.include?('try(self.input.manifest,') &&
      teardown.include?('try(self.input.master_secret_arn, "")') &&
      teardown.include?('try(self.input.shard_master_secret_arns, [])') &&
      teardown.include?('destroy_inventory_sentinel_enabled = var.enable_disposable_destroy_sentinel') &&
      teardown.include?('try(self.input.destroy_inventory_sentinel_enabled, false)')],
    'legacy_sentinel_destroy_guard' => ['pre-destroy.sh',
      pre.include?('GG_DESTROY_INVENTORY_SENTINEL_ENABLED') &&
      pre.include?('GG_VERIFIED_DESTROY_SCOPE') &&
      wrapper.include?('GG_VERIFIED_DESTROY_SCOPE="${account}:${region}:${environment}:${cluster}"') &&
      wrapper.include?('GG_VERIFIED_DESTROY_SCOPE="${account}:${region}:${environment}:${cluster}" "$terraform_bin" destroy')]
  }
  contracts.each do |id, (file, satisfied)|
    findings << { id: id, file: file, remediation: 'Restore the executable scope, guard, preflight and fail-closed teardown ordering; run teardown_test.sh.' } unless satisfied
  end
  graph_issues = destroy_anchor_graph_findings(sources)
  findings << { id: 'destroy_anchor_graph', file: 'teardown.tf', missing: graph_issues } unless graph_issues.empty?
  findings
ensure
  @sources = nil
end
end

if $PROGRAM_NAME == __FILE__
  findings = LifecycleAudit.findings
  if ARGV.include?('--json')
    puts JSON.pretty_generate({ status: findings.empty? ? 'green' : 'blocked', findings: findings })
  else
    puts "lifecycle-audit: #{findings.empty? ? 'green' : "#{findings.length} finding(s)"}"
    findings.each do |finding|
      puts "- #{finding[:id]}: #{finding[:file]}"
      puts "  #{finding[:remediation]}" if finding[:remediation]
      puts "  missing: #{finding[:missing].join(', ')}" if finding[:missing]
    end
  end
  exit(findings.empty? ? 0 : 1) if ARGV.include?('--ready')

end
