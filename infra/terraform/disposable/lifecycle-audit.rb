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
].freeze

DIRECT_INVENTORY_MARKERS = {
  'aws_cloudfront_distribution' => 'cloudfront list-distributions',
  'aws_cloudfront_vpc_origin' => 'cloudfront list-vpc-origins',
  'aws_cloudwatch_log_group' => 'logs describe-log-groups',
  'aws_cognito_user_pool' => 'cognito-idp list-user-pools',
  'aws_cognito_user_pool_domain' => 'cognito-idp describe-user-pool-domain',
  'aws_db_instance' => 'rds describe-db-instances',
  'aws_dynamodb_table' => 'dynamodb describe-table',
  'aws_eks_cluster' => 'eks list-clusters',
  'aws_lb' => 'elbv2 describe-load-balancers',
  'aws_s3_bucket' => 's3api list-buckets',
  'aws_wafv2_web_acl' => 'wafv2 list-web-acls'
}.freeze

SUPPORTING_RESOURCE_TYPES = %w[
  aws_cloudfront_cache_policy aws_cognito_user_pool_client aws_eks_access_entry
  aws_eks_access_policy_association aws_eks_pod_identity_association
  aws_flow_log aws_iam_role_policy aws_iam_role_policy_attachment
  aws_lb_listener aws_launch_template aws_route aws_route_table_association
  aws_s3_bucket_ownership_controls aws_s3_bucket_policy
  aws_s3_bucket_public_access_block aws_s3_bucket_server_side_encryption_configuration
  aws_secretsmanager_secret_version aws_vpc_security_group_egress_rule
  aws_vpc_security_group_ingress_rule
].freeze

def aws_resource_inventory_gaps(sources = nil)
  terraform_files = if sources
    sources.keys.select { |name| name.end_with?('.tf') }
  else
    Dir.glob(File.join(ROOT, '*.tf')).map { |path| File.basename(path) }
  end
  declared = terraform_files.flat_map do |file|
    source(file).scan(/\bresource\s+"(aws_[^"]+)"\s+"[^"]+"/).flatten
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

def findings(sources = nil)
  @sources = sources
  findings = []
  inventory_gaps = aws_resource_inventory_gaps(sources)
  findings << { id: 'aws_resource_inventory_coverage', file: 'check-teardown.sh',
                missing: inventory_gaps } unless inventory_gaps.empty?
  require_contract(findings, 'account_guard', 'versions.tf', 'allowed_account_ids = [var.target_account_id]', 'backend "local"')
  require_contract(findings, 'production_guard', 'pre-destroy.sh', 'production', 'actual_account="$(aws sts get-caller-identity')
  require_contract(findings, 'network_ownership', 'main.tf', 'resource "aws_vpc" "cell"', 'resource "aws_nat_gateway" "az"', 'resource "aws_eip" "nat"')
  require_contract(findings, 'rds_deletion', 'data-storage.tf', 'skip_final_snapshot         = true', 'delete_automated_backups    = true', 'deletion_protection         = false')
  require_contract(findings, 'secret_deletion', 'secrets.tf', 'recovery_window_in_days = 0')
  require_contract(findings, 'ecr_deletion', 'defaults.auto.tfvars', 'delete_nonempty_ecr_on_destroy = true')
  require_contract(findings, 'kms_deletion', 'main.tf', 'deletion_window_in_days = var.kms_deletion_window_days')
  require_contract(findings, 'cognito_deletion', 'identity.tf', 'deletion_protection      = "INACTIVE"')
  require_contract(findings, 'edge_ownership', 'edge.tf', 'resource "aws_lb" "edge"', 'resource "aws_cloudfront_distribution" "web"', 'resource "aws_cloudfront_distribution" "api"', 'resource "aws_wafv2_web_acl" "edge"')
  require_contract(findings, 'kubernetes_cleanup', 'pre-destroy.sh', 'k delete applications.argoproj.io', 'k delete ingress', 'k delete pvc', 'tagged_load_balancers')
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
    'verified_destroy_wrapper_guard' => ['teardown.tf',
      teardown.include?('GG_VERIFIED_DESTROY_SCOPE') &&
      teardown.include?('terraform destroy must be run through destroy-verified.sh') &&
      wrapper.include?('GG_VERIFIED_DESTROY_SCOPE="${account}:${region}:${environment}:${cluster}"')],
    'partial_apply_before_eks' => ['destroy-verified.sh',
      code.call('scope_override.tf').include?('terraform_data.cell_scope.output.cluster_name') &&
      wrapper.include?('"$terraform_bin" show -json') &&
      wrapper.include?('if r.get("address") == "terraform_data.cell_scope"') &&
      wrapper.include?('if scopes:') && wrapper.include?('if [ "$parse_status" -ne 42 ]; then')],
    'partial_destroy_owner_preflight' => ['pre-destroy.sh',
      ordered.call(pre, 'production', 'actual_account="$(aws sts get-caller-identity',
        '/check-teardown.sh" --preflight', 'aws iam simulate-principal-policy', 'k delete applications.argoproj.io') &&
      pre.include?('if [ -n "$denied" ] && [ "$denied" != None ]; then') &&
      ordered.call(inventory, 'production', 'actual_account="$(aws sts get-caller-identity', 'aws ec2')],
    'verified_destroy_order' => ['destroy-verified.sh',
      wrapper.include?('set -euo pipefail') &&
      ordered.call(wrapper, 'production', '"$here/pre-destroy.sh"',
        '"$terraform_bin" destroy', '"$here/check-teardown.sh"')]
  }
  contracts.each do |id, (file, satisfied)|
    findings << { id: id, file: file, remediation: 'Restore the executable scope, guard, preflight and fail-closed teardown ordering; run teardown_test.sh.' } unless satisfied
  end
  # Terraform destroy provisioners run before their resource is deleted and
  # cannot guarantee a post-destroy inventory. The wrapper is the only path
  # that can check after Terraform has removed the full state.
  findings << { id: 'raw_destroy_no_post_inventory', file: 'teardown.tf',
                remediation: 'Use destroy-verified.sh. Ordinary raw terraform destroy now fails its scope guard, but Terraform has no supported post-destroy provisioner; the wrapper must inventory after state deletion. The marker is an operational guard, not a security boundary.' }
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
