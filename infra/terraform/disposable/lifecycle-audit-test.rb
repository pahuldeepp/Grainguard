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

  def test_current_source_has_no_offline_lifecycle_contract_findings
    out, err, status = Open3.capture3('ruby', SCRIPT, '--json', '--ready')
    assert_equal '', err
    assert status.success?
    result = JSON.parse(out)
    assert_equal 'green', result.fetch('status')
    assert_empty result.fetch('findings')
  end

  def test_report_mode_is_non_destructive
    out, err, status = Open3.capture3('ruby', SCRIPT)
    assert status.success?
    assert_equal '', err
    assert_includes out, 'lifecycle-audit: green'
  end

  def test_contract_regressions_cannot_be_hidden_in_comments
    mutations = [
      ['main.tf', 'post-destroy-inventory.sh', 'missing-final-inventory.sh', 'native_post_inventory'],
      ['post-destroy-inventory.sh', 'saved scope differs from the sentinel state', 'scope check omitted', 'post_inventory_fail_closed'],
      ['scope_override.tf', 'Name        = "${terraform_data.cell_scope.output.cluster_name}-vpc"', 'Name = "missing_scope-vpc"', 'partial_apply_before_eks'],
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

  def test_comment_cannot_fake_a_complete_destroy_graph
    fixture = sources
    fixture['main.tf'] = fixture.fetch('main.tf').sub('depends_on           = [terraform_data.destroy_inventory_sentinel]', 'depends_on           = []')
    fixture['main.tf'] += "\n# destroy graph complete\n"
    finding = LifecycleAudit.findings(fixture).find { |item| item.fetch(:id) == 'destroy_anchor_graph' }
    refute_nil finding
    assert_includes finding.fetch(:missing), 'missing_sentinel_edge:aws_vpc.cell'
  end

  def test_comments_cannot_fake_sentinel_or_pre_cleanup_edges
    fixture = sources
    ['#', '//', '/* */'].each do |comment|
      fixture = sources
      fixture['main.tf'] = fixture.fetch('main.tf').sub(
        'depends_on           = [terraform_data.destroy_inventory_sentinel]',
        "depends_on           = [\n    #{comment == '/* */' ? '/* terraform_data.destroy_inventory_sentinel */' : "#{comment} terraform_data.destroy_inventory_sentinel"}\n  ]"
      )
      result = LifecycleAudit.destroy_anchor_graph_findings(fixture)
      assert_includes result, 'missing_sentinel_edge:aws_vpc.cell', "#{comment} comment cannot count as an edge"
    end

    fixture = sources
    teardown = fixture.fetch('teardown.tf').gsub(
      '    aws_vpc.cell,',
      '    // aws_vpc.cell,'
    )
    fixture['teardown.tf'] = teardown
    result = LifecycleAudit.destroy_anchor_graph_findings(fixture)
    assert_includes result, 'pre_cleanup_missing_edge:aws_vpc.cell'
  end

  def test_ecr_deletion_policy_must_be_enabled_not_just_mentioned
    fixture = sources
    fixture['defaults.auto.tfvars'] = fixture.fetch('defaults.auto.tfvars').sub(
      'delete_nonempty_ecr_on_destroy     = true',
      "delete_nonempty_ecr_on_destroy     = false\n# delete_nonempty_ecr_on_destroy = true"
    )
    assert_includes ids(fixture), 'ecr_deletion'

    fixture['defaults.auto.tfvars'] = "# delete_nonempty_ecr_on_destroy = true\n"
    assert_includes ids(fixture), 'ecr_deletion'
  end

  def test_old_pre_cleanup_inputs_have_safe_destroy_defaults
    fixture = sources
    teardown = fixture.fetch('teardown.tf')
    assert_includes teardown, 'try(self.input.manifest, "${path.module}/.last-destroy-pvs.scope.json")'
    assert_includes teardown, 'try(self.input.master_secret_arn, "")'
    assert_includes teardown, 'try(self.input.shard_master_secret_arns, [])'
    assert_includes teardown, 'try(self.input.destroy_inventory_sentinel_enabled, false)'
    assert_includes fixture.fetch('destroy-verified.sh'), '"$here/pre-destroy.sh"'
    assert_includes fixture.fetch('destroy-verified.sh'), '"$terraform_bin" destroy'

    [
      ['try(self.input.manifest, "${path.module}/.last-destroy-pvs.scope.json")', 'self.input.manifest'],
      ['try(self.input.master_secret_arn, "")', 'self.input.master_secret_arn'],
      ['try(self.input.shard_master_secret_arns, [])', 'self.input.shard_master_secret_arns'],
      ['try(self.input.destroy_inventory_sentinel_enabled, false)', 'self.input.destroy_inventory_sentinel_enabled'],
    ].each do |old, unguarded|
      broken = fixture.dup
      broken['teardown.tf'] = teardown.sub(old, unguarded)
      assert_includes ids(broken), 'legacy_cleanup_input_compatibility'
    end
  end

  def test_every_aws_resource_type_is_classified_for_teardown_inventory
    assert_empty LifecycleAudit.aws_resource_inventory_gaps(sources)

    fixture = sources
    fixture['main.tf'] += "\nresource \"aws_new_metered_service\" \"surprise\" {}\n"
    finding = LifecycleAudit.findings(fixture).find { |item| item.fetch(:id) == 'aws_resource_inventory_coverage' }
    refute_nil finding
    assert_equal ['aws_new_metered_service'], finding.fetch(:missing)
  end

  def test_commented_terraform_resources_do_not_expand_inventory_or_destroy_graph
    fixture = sources
    fixture['main.tf'] = fixture.fetch('main.tf') + <<~HCL
      # resource "aws_unowned_metered_service" "ignored" {
      #   tags = { Project = "GreenGuard" }
      # }
    HCL
    fixture['teardown.tf'] = fixture.fetch('teardown.tf') + <<~HCL
      # resource "terraform_data" "pre_destroy_cleanup" {
      #   depends_on = [aws_vpc.cell]
      # }
    HCL
    assert_empty LifecycleAudit.findings(fixture)
  end

  def test_partial_state_recovery_wrapper_remains_available
    teardown = sources.fetch('teardown.tf')
    # This owner is intentionally created after the EKS/GitOps resources it
    # cleans up. A partial apply can therefore have resources to destroy
    # without a destroy provisioner recorded in state. An anchor at the end
    # of the destroy graph cannot replace the wrapper's pre-cleanup step.
    assert_includes teardown, 'resource "terraform_data" "pre_destroy_cleanup"'
    assert_includes teardown, 'helm_release.argocd'
    assert_includes teardown, 'helm_release.gitops_bootstrap'
    assert_includes sources.fetch('main.tf'), 'resource "terraform_data" "destroy_inventory_sentinel"'
    wrapper = sources.fetch('destroy-verified.sh')
    assert_includes wrapper, '"$here/pre-destroy.sh"'
    assert_includes wrapper, '"$terraform_bin" destroy'
    assert_includes wrapper, '"$here/check-teardown.sh"'
    refute_includes teardown, 'GG_VERIFIED_DESTROY_SCOPE'
  end

  def test_live_root_graph_has_scope_anchor_fanout_and_cleanup_before_it
    assert_empty LifecycleAudit.destroy_anchor_graph_findings(sources)
    resources = sources.reject { |name, _| name == 'scope_override.tf' }.values.sum { |body| body.scan(/^resource\s+"/).length }
    assert_equal 153, resources - 1
    assert_includes sources.fetch('main.tf'), 'post-destroy-inventory.sh'
  end

  def test_telemetry_archive_and_replay_resources_are_in_both_destroy_orders
    fixture = sources
    telemetry_resources = fixture.fetch('telemetry-archive.tf').scan(/^resource\s+"(aws_[^"]+)"\s+"([^"]+)"/)
    labels = telemetry_resources.map { |type, name| "#{type}.#{name}" }
    refute_empty labels
    assert_empty LifecycleAudit.destroy_anchor_graph_findings(fixture)

    labels.each do |label|
      type, name = label.split('.', 2)
      resource_header = "resource \"#{type}\" \"#{name}\" {"
      body = fixture.fetch('telemetry-archive.tf')
      start = body.index(resource_header)
      refute_nil start, label
      finish = body.index(/^}/, start)
      refute_nil finish, label
      resource = body[start..finish]
      fixture['telemetry-archive.tf'] = body.sub(resource, resource.sub(/depends_on\s*=\s*\[[^\]]*\]/m, 'depends_on = []'))
      assert_includes LifecycleAudit.destroy_anchor_graph_findings(fixture), "missing_sentinel_edge:#{label}"
      fixture['telemetry-archive.tf'] = body

      teardown = fixture.fetch('teardown.tf')
      fixture['teardown.tf'] = teardown.sub(/\n\s*#{Regexp.escape(label)},/, '')
      assert_includes LifecycleAudit.destroy_anchor_graph_findings(fixture), "pre_cleanup_missing_edge:#{label}"
      fixture['teardown.tf'] = teardown
    end
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
