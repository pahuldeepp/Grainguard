#!/usr/bin/env ruby
require 'yaml'
require 'open3'
require 'tempfile'

chart = File.join(__dir__, 'applications-chart')
image = "ghcr.io/pahuldeepp/grainguard/ml-scoring-synthetic@sha256:#{'a' * 64}"
digest = "ghcr.io/pahuldeepp/grainguard/runtime@sha256:#{'b' * 64}"
values = {
  'cell' => 'gg-dev',
  'repositoryUrl' => 'https://github.com/pahuldeepp/Grainguard.git',
  'revision' => 'b' * 40,
  'observabilityImages' => %w[otel-collector prometheus grafana tempo loki].to_h { |name| [name, digest] },
  'cassandraPlane' => {'enabled' => false},
  'dataPlane' => {'enabled' => false},
  'searchPlane' => {'enabled' => false},
  'mqttPlane' => {'enabled' => false},
  'clickhousePlane' => {'enabled' => false},
  'edgeRouting' => {'enabled' => false},
  'mlSynthetic' => {
    'enabled' => true,
    'imageDigest' => image,
    'secretSyncEpoch' => 'version-1',
    'scopeIdentity' => '123456789012:us-west-2:dev:gg-dev:gg-dev'
  }
}
Tempfile.create(['ml-synthetic-apps-', '.yaml']) do |file|
  file.write(values.to_yaml)
  file.flush
  output, error, status = Open3.capture3('helm', 'template', 'ml-synthetic-test', chart, '--namespace', 'argocd', '-f', file.path)
  abort "ML synthetic Argo render failed: #{error}" unless status.success?
  apps = YAML.load_stream(output).compact
  expected = {
    'greenguard-ml-synthetic-data' => ['10', 'services/ml-scoring/deploy/data-chart'],
    'greenguard-ml-synthetic-scorer' => ['20', 'services/ml-scoring/deploy/chart']
  }
  ml_apps = apps.select { |app| app.dig('metadata', 'name').to_s.start_with?('greenguard-ml-synthetic-') }
  abort 'synthetic Argo Application inventory differs' unless ml_apps.map { |app| app.dig('metadata', 'name') }.sort == expected.keys.sort
  expected.each do |name, (wave, path)|
    app = ml_apps.find { |item| item.dig('metadata', 'name') == name }
    abort "#{name}: source/revision/order/ownership differs" unless
      app.dig('metadata', 'labels', 'greenguard.io/cell') == values['cell'] &&
      app.dig('metadata', 'annotations', 'argocd.argoproj.io/sync-wave') == wave &&
      app.dig('metadata', 'finalizers') == ['resources-finalizer.argocd.argoproj.io'] &&
      app.dig('spec', 'source', 'path') == path &&
      app.dig('spec', 'source', 'targetRevision') == values['revision'] &&
      app.dig('spec', 'destination', 'namespace') == 'ml-synthetic' &&
      app.dig('spec', 'syncPolicy', 'managedNamespaceMetadata', 'labels', 'greenguard.io/isolation') == 'synthetic-only' &&
      app.dig('spec', 'syncPolicy', 'managedNamespaceMetadata', 'labels', 'istio-injection') == 'disabled' &&
      app.dig('spec', 'syncPolicy', 'managedNamespaceMetadata', 'annotations', 'greenguard.io/terraform-scope') == values.dig('mlSynthetic', 'scopeIdentity')
  end
  scorer = ml_apps.find { |app| app.dig('metadata', 'name') == 'greenguard-ml-synthetic-scorer' }
  scorer_values = scorer.dig('spec', 'source', 'helm', 'valuesObject')
  abort 'synthetic scorer image, operation endpoint or fixture seeding drifted' unless
    scorer_values.dig('image', 'repository') == image.split('@sha256:').first &&
    scorer_values.dig('image', 'digest') == 'a' * 64 &&
    scorer_values['nameOverride'] == 'ml-scoring-synthetic' &&
    scorer_values.dig('syntheticFixtureSeed', 'enabled') == true &&
    scorer_values.dig('syntheticFixtureSeed', 'count') == 384
  data = ml_apps.find { |app| app.dig('metadata', 'name') == 'greenguard-ml-synthetic-data' }
  abort 'synthetic DB/Kafka prerequisites are not explicitly enabled and cell-scoped' unless
    data.dig('spec', 'source', 'helm', 'valuesObject') == {'enabled' => true, 'cell' => values['cell']}
  abort 'synthetic scorer cell label is not forwarded' unless scorer_values['cell'] == values['cell']
end

[{ 'imageDigest' => 'ghcr.io/untrusted/scorer@sha256:' + 'a' * 64 },
 { 'secretSyncEpoch' => '' },
 { 'scopeIdentity' => '123456789012:us-west-2:production:gg-dev:gg-dev' }].each do |change|
  invalid = values.merge('mlSynthetic' => values['mlSynthetic'].merge(change))
  Tempfile.create(['ml-synthetic-invalid-', '.yaml']) do |file|
    file.write(invalid.to_yaml)
    file.flush
    _output, _error, status = Open3.capture3('helm', 'template', 'ml-synthetic-test', chart, '--namespace', 'argocd', '-f', file.path)
    abort "unsafe ML synthetic values accepted: #{change.keys.join(',')}" if status.success?
  end
end
puts 'ML synthetic Argo Applications: disabled by default; exact scope, CI digest, ordered isolated DB/Kafka and shadow scorer, and safe tenant-neutral boundaries verified.'
