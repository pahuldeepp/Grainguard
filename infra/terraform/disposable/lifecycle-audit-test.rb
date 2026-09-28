#!/usr/bin/env ruby
require 'json'
require 'open3'
require 'minitest/autorun'
require_relative 'lifecycle-audit'

class LifecycleAuditTest < Minitest::Test
  SCRIPT = File.expand_path('lifecycle-audit.rb', __dir__)

  def sources
    Dir.glob(File.join(__dir__, '*.{sh,tf,tfvars}')).to_h { |path| [File.basename(path), File.read(path)] }
  end

  def ids(input)
    LifecycleAudit.findings(input).map { |item| item.fetch(:id) }
  end

  def test_current_source_retains_only_raw_destroy_blocker
    out, err, status = Open3.capture3('ruby', SCRIPT, '--json', '--ready')
    assert_equal '', err
    refute status.success?
    result = JSON.parse(out)
    assert_equal 'blocked', result.fetch('status')
    assert_equal ['raw_destroy_no_post_inventory'], result.fetch('findings').map { |item| item.fetch('id') }
  end

  def test_report_mode_is_non_destructive
    out, err, status = Open3.capture3('ruby', SCRIPT)
    assert status.success?
    assert_equal '', err
    assert_includes out, 'lifecycle-audit: 1 finding(s)'
  end

  def test_contract_regressions_cannot_be_hidden_in_comments
    mutations = [
      ['teardown.tf', 'GG_VERIFIED_DESTROY_SCOPE', 'GG_UNSCOPED_DESTROY', 'verified_destroy_wrapper_guard'],
      ['destroy-verified.sh', 'GG_VERIFIED_DESTROY_SCOPE="${account}:${region}:${environment}:${cluster}"', 'echo skip marker', 'verified_destroy_wrapper_guard'],
      ['scope_override.tf', 'terraform_data.cell_scope.output.cluster_name', 'missing_scope', 'partial_apply_before_eks'],
      ['destroy-verified.sh', 'if scopes:', 'if False:', 'partial_apply_before_eks'],
      ['destroy-verified.sh', 'if [ "$parse_status" -ne 42 ]; then', 'if false; then', 'partial_apply_before_eks'],
      ['pre-destroy.sh', '/check-teardown.sh" --preflight', '/check-teardown.sh"', 'partial_destroy_owner_preflight'],
      ['pre-destroy.sh', 'aws iam simulate-principal-policy', 'echo simulation', 'partial_destroy_owner_preflight'],
      ['check-teardown.sh', 'actual_account="$(aws sts get-caller-identity', 'actual_account="$(echo', 'partial_destroy_owner_preflight'],
      ['destroy-verified.sh', '"$here/check-teardown.sh"', 'echo inventory', 'verified_destroy_order'],
      ['destroy-verified.sh', 'set -euo pipefail', 'set +e', 'verified_destroy_order']
    ]
    mutations.each do |file, before, after, finding|
      fixture = sources
      assert_includes fixture.fetch(file), before
      fixture[file] = fixture.fetch(file).sub(before, after) + "\n# #{before}\n"
      assert_includes ids(fixture), finding, "#{file}: #{before}"
    end
  end

  def test_reordered_destroy_does_not_pass
    fixture = sources
    fixture['destroy-verified.sh'] = fixture.fetch('destroy-verified.sh').sub('"$terraform_bin" destroy', 'echo destroy') + "\n\"$terraform_bin\" destroy\n"
    assert_includes ids(fixture), 'verified_destroy_order'
  end

  def test_magic_post_inventory_marker_does_not_close_raw_destroy_gap
    fixture = sources
    fixture['teardown.tf'] += "\n# post_destroy_inventory_guaranteed\n"
    assert_includes ids(fixture), 'raw_destroy_no_post_inventory'
  end

  def test_every_aws_resource_type_is_classified_for_teardown_inventory
    assert_empty LifecycleAudit.aws_resource_inventory_gaps(sources)

    fixture = sources
    fixture['main.tf'] += "\nresource \"aws_new_metered_service\" \"surprise\" {}\n"
    finding = LifecycleAudit.findings(fixture).find { |item| item.fetch(:id) == 'aws_resource_inventory_coverage' }
    refute_nil finding
    assert_equal ['aws_new_metered_service'], finding.fetch(:missing)
  end

  def test_raw_destroy_guard_remains_because_partial_state_can_omit_cleanup_owner
    teardown = sources.fetch('teardown.tf')
    # This owner is intentionally created after the EKS/GitOps resources it
    # cleans up. A partial apply can therefore have resources to destroy
    # without a destroy provisioner recorded in state. An anchor at the end
    # of the destroy graph cannot replace the wrapper's pre-cleanup step.
    assert_includes teardown, 'resource "terraform_data" "pre_destroy_cleanup"'
    assert_includes teardown, 'helm_release.argocd'
    assert_includes teardown, 'helm_release.gitops_bootstrap'
    assert_includes teardown, 'GG_VERIFIED_DESTROY_SCOPE'
    assert_includes ids(sources), 'raw_destroy_no_post_inventory'
  end

  def test_destroy_anchor_graph_contract_rejects_missing_edges_and_resource_inputs
    # Terraform reverses dependency edges during destroy: if every managed
    # object depends on a state-only anchor, the anchor's destroy provisioner
    # is last. The anchor must have no resource-derived inputs, or those
    # references create a dependency cycle when the resources depend on it.
    valid = {
      'main.tf' => <<~HCL,
        resource "terraform_data" "final_inventory" {
          input = { region = var.aws_region }
          provisioner "local-exec" {
            when = destroy
            command = "./check-teardown.sh"
          }
        }
        resource "aws_vpc" "cell" {
          depends_on = [terraform_data.final_inventory]
        }
        resource "aws_db_instance" "db" {
          depends_on = [terraform_data.final_inventory]
        }
      HCL
      'modules.tf' => <<~HCL
        module "platform" {
          source = "./platform"
          depends_on = [terraform_data.final_inventory]
        }
      HCL
    }
    assert_equal [], anchor_graph_findings(valid)

    missing_resource_edge = Marshal.load(Marshal.dump(valid))
    missing_resource_edge['main.tf'].sub!('depends_on = [terraform_data.final_inventory]', 'depends_on = []')
    assert_includes anchor_graph_findings(missing_resource_edge), 'aws_vpc.cell'

    missing_module_edge = Marshal.load(Marshal.dump(valid))
    missing_module_edge['modules.tf'].sub!('depends_on = [terraform_data.final_inventory]', 'depends_on = []')
    assert_includes anchor_graph_findings(missing_module_edge), 'module.platform'

    resource_input = Marshal.load(Marshal.dump(valid))
    resource_input['main.tf'].sub!('region = var.aws_region', 'db = aws_db_instance.db.address')
    assert_includes anchor_graph_findings(resource_input), 'anchor_has_resource_reference'
  end

  # Small source-contract parser for the proposed anchor shape. This is not a
  # replacement for `terraform graph`; it catches incomplete dependency
  # inventories in offline CI and gives graph ordering an explicit invariant.
  def anchor_graph_findings(fixture)
    blocks = fixture.flat_map do |file, text|
      text.scan(/^\s*(resource|module)\s+"([^"]+)"\s+"?([^"\s{]+)?"?\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/m).map do |kind, type, name, body|
        label = kind == 'module' ? "module.#{type}" : "#{type}.#{name}"
        [label, body]
      end
    end
    anchor = blocks.select { |label, _| label == 'terraform_data.final_inventory' }
    return ['missing_or_duplicate_anchor'] unless anchor.length == 1

    anchor_body = anchor.first.last
    findings = []
    if anchor_body.match?(/\b(?:aws_[a-z0-9_]+|terraform_data)\.[a-zA-Z0-9_-]+/)
      findings << 'anchor_has_resource_reference'
    end
    blocks.each do |label, body|
      next if label == 'terraform_data.final_inventory'
      findings << label unless body.match?(/depends_on\s*=\s*\[[^\]]*terraform_data\.final_inventory[^\]]*\]/m)
    end
    findings
  end

  def test_offline_teardown_behavior_fixtures
    out, err, status = Open3.capture3('bash', File.join(__dir__, 'teardown_test.sh'))
    assert status.success?, "#{out}\n#{err}"
  end
end
