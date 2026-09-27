#!/usr/bin/env ruby
require 'json'
require 'open3'
require 'minitest/autorun'

class LifecycleAuditTest < Minitest::Test
  SCRIPT = File.expand_path('lifecycle-audit.rb', __dir__)

  def test_current_source_has_three_explicit_lifecycle_blockers
    out, err, status = Open3.capture3('ruby', SCRIPT, '--json', '--ready')
    assert_equal '', err
    refute status.success?
    result = JSON.parse(out)
    assert_equal 'blocked', result.fetch('status')
    assert_equal %w[partial_apply_before_eks partial_destroy_owner_preflight raw_destroy_no_post_inventory],
                 result.fetch('findings').map { |item| item.fetch('id') }
    result.fetch('findings').each { |item| refute_empty item.fetch('remediation') }
  end

  def test_report_mode_is_non_destructive
    out, err, status = Open3.capture3('ruby', SCRIPT)
    assert status.success?
    assert_equal '', err
    assert_includes out, 'lifecycle-audit: 3 finding(s)'
  end
end
