#!/usr/bin/env ruby
# Offline contract for the disposable cell's costly-resource lifecycle.
# This checks source contracts, not AWS behavior. Run from any directory.
require 'json'

ROOT = File.expand_path(__dir__)
def source(name)
  File.read(File.join(ROOT, name))
end

findings = []
def require_contract(findings, id, file, *markers)
  body = source(file)
  missing = markers.reject { |marker| body.include?(marker) }
  findings << { id: id, file: file, missing: missing } unless missing.empty?
end

require_contract(findings, 'account_guard', 'versions.tf', 'allowed_account_ids = [var.target_account_id]', 'backend "local"')
require_contract(findings, 'production_guard', 'pre-destroy.sh', 'if [ "$GG_ENVIRONMENT" = "prod" ]', 'actual_account="$(aws sts get-caller-identity')
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

# These are real gaps. Do not silently turn them green by weakening this audit.
wrapper = source('destroy-verified.sh')
unless wrapper.include?('partial-state-without-cluster') && wrapper.include?('partial_state_inventory_scope')
  findings << { id: 'partial_apply_before_eks', file: 'destroy-verified.sh',
                remediation: 'Persist a tagged cell scope before any billable resource, and recover region/account/environment from state for a partial apply with VPC/NAT/RDS but no EKS. Guard the account before cleanup or destroy.' }
end
unless wrapper.include?('preflight_all_managed_resource_owners')
  findings << { id: 'partial_destroy_owner_preflight', file: 'destroy-verified.sh',
                remediation: 'Preflight provider credentials, private EKS reachability, Argo/Helm access, and the final-inventory API permissions before mutating resources; preserve a resumable scope after any failure.' }
end
unless source('teardown.tf').include?('post_destroy_inventory_guaranteed')
  findings << { id: 'raw_destroy_no_post_inventory', file: 'teardown.tf',
                remediation: 'Terraform destroy provisioners cannot guarantee a post-destroy inventory. Make the verified wrapper the supported operator command or add an external post-destroy orchestrator; document that raw terraform destroy cannot satisfy zero-billable proof.' }
end

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
