#!/usr/bin/env ruby
require 'minitest/autorun'
require 'open3'
require 'tempfile'
require 'yaml'

class MigrationRevisionTest < Minitest::Test
  ROOT = __dir__
  def fixture
    owners = %w[control billing telemetry projection jobs saga hardware inventory alerts risk notifications]
    digest = "registry.test/migrate@sha256:#{'a' * 64}"
    {
      'revision' => 'b' * 40, 'caSecret' => 'greenguard-rds-ca', 'sqlImage' => digest,
      'gateImage' => "registry.test/kubectl@sha256:#{'c' * 64}",
      'rdsCIDRs' => ['10.1.0.0/20'], 'apiServerCIDR' => '172.20.0.1/32',
      'images' => owners.to_h { |owner| [owner, digest] },
      'scopes' => %w[central s1 s2 s3 s4].to_h { |scope| [scope, {
        'rdsHost' => "#{scope}.test.us-east-1.rds.amazonaws.com",
        'secrets' => (scope == 'central' ? %w[control billing] : owners - %w[control billing]).to_h { |owner| [owner, "#{scope}-#{owner}-migrator"] }
      }] }
    }
  end

  def render(chart, values)
    Tempfile.create(['migration-revisions', '.yaml']) do |file|
      file.write(values.to_yaml); file.flush
      output, error, status = Open3.capture3('helm', 'template', 'test', File.join(ROOT, chart), '--values', file.path)
      assert status.success?, error
      YAML.load_stream(output).compact
    end
  end

  def jobs_and_gate(values)
    names = render('owner-migrations-chart', values).select { |doc| doc['kind'] == 'Job' }.map { |job| job.dig('metadata', 'name') }.sort
    gate = render('migration-gate-chart', values)
    role = gate.find { |doc| doc['kind'] == 'Role' }
    assert_equal names, role.dig('rules', 0, 'resourceNames').sort
    [names, gate.find { |doc| doc['kind'] == 'Job' }.dig('metadata', 'name')]
  end

  def test_behavior_changes_get_fresh_jobs_and_exact_gate_dependencies
    original = fixture
    original_names, original_gate = jobs_and_gate(original)
    assert_equal 38, original_names.length
    mutations = [
      ->(v) { v['revision'] = 'd' * 40 },
      ->(v) { v['sqlImage'] = "registry.test/psql@sha256:#{'d' * 64}" },
      ->(v) { v['gateImage'] = "registry.test/kubectl@sha256:#{'e' * 64}" },
      ->(v) { v['rdsCIDRs'] = ['10.2.0.0/20'] },
      ->(v) { v['apiServerCIDR'] = '172.20.0.2/32' },
      ->(v) { v['caSecret'] = 'updated-rds-ca' },
      ->(v) { v['scopes']['s1']['rdsHost'] = 'replacement.test.us-east-1.rds.amazonaws.com' },
      ->(v) { v['scopes']['s1']['secrets']['inventory'] = 'replacement-inventory-migrator' },
      ->(v) { v['images']['inventory'] = "registry.test/inventory@sha256:#{'f' * 64}" }
    ]
    mutations.each do |mutation|
      changed = fixture; mutation.call(changed)
      names, gate = jobs_and_gate(changed)
      refute_equal original_names, names
      refute_equal original_gate, gate
    end
  end

  def test_application_revision_overrides_stale_nested_revision_and_propagates_configuration
    values = fixture
    root = {
      'revision' => 'd' * 40, 'cell' => 'test-cell', 'repositoryUrl' => 'https://repo.test/greenguard.git',
      'observabilityImages' => %w[otel-collector prometheus grafana tempo loki].to_h { |name| [name, "registry.test/observe@sha256:#{'a' * 64}"] },
      'ownerMigrations' => values
    }
    docs = render('applications-chart', root)
    %w[greenguard-owner-migrations greenguard-migration-gate].each do |name|
      app = docs.find { |doc| doc.dig('metadata', 'name') == name }
      assert_equal root['revision'], app.dig('spec', 'source', 'targetRevision')
      rendered = app.dig('spec', 'source', 'helm', 'valuesObject')
      assert_equal root['revision'], rendered['revision']
      assert_equal values.reject { |key, _| key == 'revision' }, rendered.reject { |key, _| key == 'revision' }
    end
  end
end
