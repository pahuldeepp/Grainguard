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

def findings(sources = nil)
  @sources = sources
  findings = []
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
  inventory = code.call('check-teardown.sh')
  ordered = lambda do |body, *steps|
    positions = steps.map { |step| body.index(step) }
    positions.none?(&:nil?) && positions.each_cons(2).all? { |a, b| a < b }
  end
  contracts = {
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
  # No supported post-destroy graph contract exists today. A magic marker cannot close this gap.
  findings << { id: 'raw_destroy_no_post_inventory', file: 'teardown.tf',
                remediation: 'Use destroy-verified.sh for final inventory. Raw terraform destroy has no supported guaranteed post-destroy inventory; an executable graph or external orchestration contract and failure fixtures are required to close this finding.' }
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
