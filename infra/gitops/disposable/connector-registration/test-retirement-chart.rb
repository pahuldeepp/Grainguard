#!/usr/bin/env ruby
require 'minitest/autorun'
require 'yaml'
require 'open3'
require 'tempfile'

class RetirementChartTest < Minitest::Test
  def fixture(retirement = true)
    values = {'image' => "registry.test/python-psql@sha256:#{'a' * 64}", 'rdsHost' => 'central.rds.amazonaws.com'}
    values.merge!({
      'shards' => (1..4).to_h { |i| ["s#{i}", "s#{i}.rds.amazonaws.com"] },
      'centralRetirementReceiptSecret' => 'approved-cutover-receipt',
      'centralRetirementReceiptRevision' => 'b' * 64,
      'credentialSecret' => 'central-cdc-credentials', 'caSecret' => 'central-rds-ca',
      'rdsCIDRs' => ['10.1.0.0/20']
    }) if retirement
    values
  end

  def render(values)
    Tempfile.create(['retirement-chart', '.yaml']) do |file|
      file.write(values.to_yaml); file.flush
      Open3.capture3('helm', 'template', 'registration', __dir__, '--values', file.path)
    end
  end

  def documents(values)
    output, error, status = render(values)
    assert status.success?, error
    YAML.load_stream(output).compact
  end

  def test_ordinary_registration_receives_no_cdc_password_or_sql_access
    docs = documents(fixture(false))
    pod = docs.find { |doc| doc['kind'] == 'Job' }.dig('spec', 'template', 'spec')
    refute pod.dig('containers', 0, 'env').any? { |entry| entry['name'] == 'CDC_DB_PASSWORD' }
    refute pod.dig('containers', 0, 'volumeMounts').any? { |mount| mount['name'] == 'rds-ca' }
    refute docs.any? { |doc| doc['kind'] == 'NetworkPolicy' }
  end

  def test_receipt_mode_has_scoped_credentials_tls_and_bounded_egress
    docs = documents(fixture)
    pod = docs.find { |doc| doc['kind'] == 'Job' }.dig('spec', 'template', 'spec')
    credential = pod.dig('containers', 0, 'env').find { |entry| entry['name'] == 'CDC_DB_PASSWORD' }
    assert_equal({'name' => 'central-cdc-credentials', 'key' => 'CDC_DB_PASSWORD'}, credential.dig('valueFrom', 'secretKeyRef'))
    ca = pod['volumes'].find { |volume| volume['name'] == 'rds-ca' }
    assert_equal 'central-rds-ca', ca.dig('secret', 'secretName')
    policy = docs.find { |doc| doc['kind'] == 'NetworkPolicy' }
    assert_equal ['10.1.0.0/20'], policy.dig('spec', 'egress').flat_map { |rule| rule['to'].filter_map { |peer| peer.dig('ipBlock', 'cidr') } }
    assert_equal [53, 5432, 8083, 15012, 15014], policy.dig('spec', 'egress').flat_map { |rule| rule['ports'].map { |port| port['port'] } }.uniq.sort
  end

  def test_retirement_missing_or_unbounded_scope_fails
    [->(v) {v['rdsCIDRs'] = []}, ->(v) {v['rdsCIDRs'] = ['0.0.0.0/0']},
     ->(v) {v['caSecret'] = ''}, ->(v) {v['credentialSecret'] = ''},
     ->(v) {v['shards'] = {}}, ->(v) {v['centralRetirementReceiptRevision'] = 'mutable'}].each do |mutate|
      values = fixture; mutate.call(values)
      _, _, status = render(values)
      refute status.success?
    end
  end

  def test_credentials_ca_and_network_changes_get_new_job_names
    job_name = ->(values) { documents(values).find { |doc| doc['kind'] == 'Job' }.dig('metadata', 'name') }
    original = job_name.call(fixture)
    [->(v) {v['rdsCIDRs'] = ['10.2.0.0/20']}, ->(v) {v['caSecret'] = 'new-rds-ca'},
     ->(v) {v['credentialSecret'] = 'new-central-cdc'}, ->(v) {v['connectUrl'] = 'http://connect:8083'}].each do |mutate|
      values = fixture; mutate.call(values)
      refute_equal original, job_name.call(values)
    end
  end
end
