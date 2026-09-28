#!/usr/bin/env ruby
require 'yaml'
require 'open3'
require 'tempfile'

root = __dir__
digest = "example.test/greenguard/data@sha256:#{'a' * 64}"
values = {
  'cell' => 'greenguard-test',
  'repositoryUrl' => 'https://example.test/greenguard.git',
  'revision' => 'b' * 40,
  'observabilityImages' => %w[otel-collector prometheus grafana tempo loki].to_h { |name| [name, digest] },
  'dataPlane' => {
    'enabled' => true,
    'rdsHost' => 'db.example.us-east-1.rds.amazonaws.com',
    'images' => %w[pgbouncer kafka-topics kafka-connect connector-registration].to_h { |name| [name, digest] },
    'secrets' => {
      'pgbouncerAuth' => 'greenguard-pgbouncer-auth',
      'rdsCa' => 'greenguard-rds-ca',
      'cdcCredentials' => 'greenguard-cdc-credentials'
    }
  }
}

render = lambda do |chart, fixture|
  Tempfile.create(['data-plane-', '.yaml']) do |file|
    file.write(fixture.to_yaml)
    file.flush
    Open3.capture3('helm', 'template', 'data-plane', File.join(root, chart), '--namespace', 'argocd', '-f', file.path)
  end
end

output, error, status = render.call('applications-chart', values)
abort "data plane Argo render failed: #{error}" unless status.success?
apps = YAML.safe_load_stream(output).compact
registry = apps.find { |item| item.dig('metadata', 'name') == 'greenguard-schema-registry' }
abort 'Registry must follow ACL/topic bootstrap in wave 13' unless registry &&
  registry.dig('metadata', 'annotations', 'argocd.argoproj.io/sync-wave') == '13' &&
  registry.dig('spec', 'source', 'path') == 'infra/kubernetes/disposable-data/registry' &&
  registry.dig('metadata', 'finalizers') == ['resources-finalizer.argocd.argoproj.io']
expected = {
  'greenguard-kafka-topics' => ['12', 'streaming-topics-chart'],
  'greenguard-pgbouncer' => ['22', 'pgbouncer-chart'],
  'greenguard-kafka-connect' => ['23', 'kafka-connect-chart'],
  'greenguard-connector-registration' => ['24', 'connector-registration']
}
expected.each do |name, (wave, chart)|
  app = apps.find { |item| item.dig('metadata', 'name') == name }
  abort "#{name} Application missing" unless app
  abort "#{name} ordering/source wrong" unless app.dig('metadata', 'annotations', 'argocd.argoproj.io/sync-wave') == wave &&
    app.dig('spec', 'source', 'path') == "infra/gitops/disposable/#{chart}" &&
    app.dig('spec', 'source', 'targetRevision') == values['revision']
  abort "#{name} lifecycle ownership missing" unless app.dig('metadata', 'finalizers') == ['resources-finalizer.argocd.argoproj.io']
end
abort 'PgBouncer source values drifted' unless apps.find { |item| item.dig('metadata', 'name') == 'greenguard-pgbouncer' }
  .dig('spec', 'source', 'helm', 'valuesObject') == {
    'image' => digest, 'rdsHost' => values.dig('dataPlane', 'rdsHost'),
    'authSecret' => 'greenguard-pgbouncer-auth', 'caSecret' => 'greenguard-rds-ca'
  }
abort 'Connect source Secret drifted' unless apps.find { |item| item.dig('metadata', 'name') == 'greenguard-kafka-connect' }
  .dig('spec', 'source', 'helm', 'valuesObject', 'credentialSecret') == 'greenguard-cdc-credentials'

root_output, root_error, root_status = render.call('bootstrap-chart', values)
abort "root data-plane render failed: #{root_error}" unless root_status.success?
root_app = YAML.safe_load_stream(root_output).compact.fetch(0)
abort 'root lost data-plane values' unless root_app.dig('spec', 'source', 'helm', 'valuesObject', 'dataPlane') == values.fetch('dataPlane')

bad = Marshal.load(Marshal.dump(values))
bad['dataPlane']['images']['kafka-connect'] = 'mutable:latest'
_, _, invalid = render.call('applications-chart', bad)
abort 'mutable Connect image accepted' if invalid.success?
_, _, invalid_root = render.call('bootstrap-chart', bad)
abort 'root accepted mutable Connect image' if invalid_root.success?
bad = Marshal.load(Marshal.dump(values))
bad['dataPlane']['secrets'].delete('cdcCredentials')
_, _, invalid = render.call('applications-chart', bad)
abort 'missing CDC Secret accepted' if invalid.success?
_, _, invalid_root = render.call('bootstrap-chart', bad)
abort 'root accepted missing CDC Secret' if invalid_root.success?
bad = Marshal.load(Marshal.dump(values))
bad['dataPlane']['rdsHost'] = 'attacker.example.test'
_, _, invalid = render.call('applications-chart', bad)
abort 'non-RDS host accepted' if invalid.success?
_, _, invalid_root = render.call('bootstrap-chart', bad)
abort 'root accepted non-RDS host' if invalid_root.success?
bad = Marshal.load(Marshal.dump(values))
bad['dataPlane']['enabled'] = 'false'
_, _, invalid = render.call('applications-chart', bad)
abort 'string false enabled data plane accepted' if invalid.success?
_, _, invalid_root = render.call('bootstrap-chart', bad)
abort 'root accepted string false enabled data plane' if invalid_root.success?
bad = Marshal.load(Marshal.dump(values))
bad['dataPlane']['enabled'] = false
disabled_output, disabled_error, disabled_status = render.call('applications-chart', bad)
abort "disabled data-plane render failed: #{disabled_error}" unless disabled_status.success?
abort 'Registry must not start without ACL/topic child' if YAML.safe_load_stream(disabled_output).compact.any? { |item| item.dig('metadata', 'name') == 'greenguard-schema-registry' }
disabled_apps = YAML.safe_load_stream(disabled_output).compact
abort 'data-plane child rendered while disabled' if disabled_apps.any? { |item| expected.key?(item.dig('metadata', 'name')) }

puts 'Data-plane Argo children, ordering, pinned values, and reject fixtures pass.'
