#!/usr/bin/env ruby
require 'yaml'
require 'open3'
require 'tempfile'

root = __dir__
digest = "example.test/greenguard/cassandra@sha256:#{'a' * 64}"
values = {
  'cell' => 'greenguard-test',
  'repositoryUrl' => 'https://example.test/greenguard.git',
  'revision' => 'b' * 40,
  'observabilityImages' => %w[otel-collector prometheus grafana tempo loki].to_h { |name| [name, digest] },
  'cassandraPlane' => {
    'enabled' => true, 'image' => digest, 'migratorImage' => digest,
    'authSecret' => 'greenguard-cassandra-auth', 'tlsSecret' => 'greenguard-cassandra-tls',
    'apiServerCIDR' => '10.100.0.1/32'
  }
}
render = lambda do |chart, fixture|
  Tempfile.create(['cassandra-plane-', '.yaml']) do |file|
    file.write(fixture.to_yaml)
    file.flush
    Open3.capture3('helm', 'template', 'cassandra-plane', File.join(root, chart), '--namespace', 'argocd', '-f', file.path)
  end
end
output, error, status = render.call('applications-chart', values)
abort "Cassandra Argo render failed: #{error}" unless status.success?
app = YAML.safe_load_stream(output).compact.find { |item| item.dig('metadata', 'name') == 'greenguard-cassandra' }
abort 'Cassandra child missing' unless app
abort 'Cassandra ordering, source or ownership wrong' unless
  app.dig('metadata', 'annotations', 'argocd.argoproj.io/sync-wave') == '24' &&
  app.dig('metadata', 'finalizers') == ['resources-finalizer.argocd.argoproj.io'] &&
  app.dig('spec', 'source', 'path') == 'infra/gitops/disposable/cassandra-chart' &&
  app.dig('spec', 'source', 'targetRevision') == values['revision']
abort 'Cassandra image and Secret values drifted' unless
  app.dig('spec', 'source', 'helm', 'valuesObject') == {
    'cassandraImage' => digest, 'migratorImage' => digest,
    'authSecret' => 'greenguard-cassandra-auth', 'tlsSecret' => 'greenguard-cassandra-tls',
    'apiServerCIDR' => '10.100.0.1/32'
  }
root_output, root_error, root_status = render.call('bootstrap-chart', values)
abort "root Cassandra render failed: #{root_error}" unless root_status.success?
root_app = YAML.safe_load_stream(root_output).compact.fetch(0)
abort 'root lost Cassandra values' unless root_app.dig('spec', 'source', 'helm', 'valuesObject', 'cassandraPlane') == values.fetch('cassandraPlane')

%w[image migratorImage authSecret tlsSecret apiServerCIDR].each do |key|
  bad = Marshal.load(Marshal.dump(values))
  bad['cassandraPlane'][key] = 'mutable:latest'
  %w[applications-chart bootstrap-chart].each do |chart|
    _, _, invalid = render.call(chart, bad)
    abort "#{chart} accepted bad #{key}" if invalid.success?
  end
end
bad = Marshal.load(Marshal.dump(values))
bad['cassandraPlane']['enabled'] = false
disabled_output, disabled_error, disabled_status = render.call('applications-chart', bad)
abort "disabled Cassandra render failed: #{disabled_error}" unless disabled_status.success?
abort 'disabled Cassandra still rendered' if YAML.safe_load_stream(disabled_output).compact.any? { |item| item.dig('metadata', 'name') == 'greenguard-cassandra' }
puts 'Cassandra Argo child, ordering, pinned values, and reject fixtures pass.'
