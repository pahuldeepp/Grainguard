require 'minitest/autorun'
require_relative 'minimum-capacity'

class MinimumCapacityTest < Minitest::Test
  def test_current_complete_service_set_cannot_fit_eight_vcpus
    report = MinimumCapacity.report(File.expand_path('../../..', __dir__))
    assert_operator report.fetch('lower_bound_millicpu'), :>, 8000
    refute report.fetch('fits_8_vcpus_even_before_node_overhead')
    assert_equal 33, report.fetch('application_count')
    assert_equal 600, report.fetch('data').find { |row| row['name'] == 'redis-cluster' }.fetch('millicpu')
  end

  def test_merge_preserves_resource_defaults
    actual = MinimumCapacity.merge({'requests' => {'cpu' => '100m', 'memory' => '128Mi'}}, {'requests' => {'memory' => '256Mi'}})
    assert_equal({'requests' => {'cpu' => '100m', 'memory' => '256Mi'}}, actual)
  end

  def test_cpu_units_fail_closed
    assert_equal 250, MinimumCapacity.millicpu('250m')
    assert_equal 500, MinimumCapacity.millicpu('0.5')
    assert_raises(RuntimeError) { MinimumCapacity.millicpu('invalid') }
  end
end
