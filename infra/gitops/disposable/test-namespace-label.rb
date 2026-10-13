#!/usr/bin/env ruby
require 'minitest/autorun'
require 'open3'
require 'yaml'

class NamespaceLabelTest < Minitest::Test
  CHART = File.join(__dir__, 'namespace-chart')

  def test_valid_labels_include_length_boundaries
    ['x', 'A_b-9', 'a' * 63].each do |cell|
      output, error, status = Open3.capture3('helm', 'template', 'namespace', CHART, '--set-string', "cell=#{cell}")
      assert status.success?, error
      assert_equal cell, YAML.safe_load(output).dig('metadata', 'labels', 'greenguard.io/cell')
    end
  end

  def test_invalid_labels_fail_rendering
    ['', 'a' * 64, 'a-', 'a_', '-a', '_a', 'space cell', 'a/b'].each do |cell|
      _, _, status = Open3.capture3('helm', 'template', 'namespace', CHART, '--set-string', "cell=#{cell}")
      refute status.success?, "accepted #{cell.inspect}"
    end
  end
end
