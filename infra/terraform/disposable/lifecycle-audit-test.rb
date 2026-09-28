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

  def test_offline_teardown_behavior_fixtures
    out, err, status = Open3.capture3('bash', File.join(__dir__, 'teardown_test.sh'))
    assert status.success?, "#{out}\n#{err}"
  end
end
