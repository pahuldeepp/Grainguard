#!/usr/bin/env ruby
require 'yaml'
require 'open3'
require 'tempfile'

root = __dir__
digest = "example.test/greenguard/search@sha256:#{'a' * 64}"
values = {
  'cell' => 'greenguard-test',
  'repositoryUrl' => 'https://example.test/greenguard.git',
  'revision' => 'b' * 40,
  'observabilityImages' => %w[otel-collector prometheus grafana tempo loki].to_h { |name| [name, digest] },
  'searchPlane' => { 'enabled' => true, 'image' => digest, 'bootstrapImage' => digest }
}

render = lambda do |chart, fixture|
  Tempfile.create(['search-plane-', '.yaml']) do |file|
    file.write(fixture.to_yaml)
    file.flush
    Open3.capture3('helm', 'template', 'search-plane', File.join(root, chart), '--namespace', 'argocd', '-f', file.path)
  end
end

output, error, status = render.call('applications-chart', values)
abort "search Argo render failed: #{error}" unless status.success?
apps = YAML.load_stream(output).compact
app = apps.find { |item| item.dig('metadata', 'name') == 'greenguard-opensearch' }
abort 'OpenSearch child missing' unless app
abort 'OpenSearch ordering, source or ownership wrong' unless
  app.dig('metadata', 'annotations', 'argocd.argoproj.io/sync-wave') == '24' &&
  app.dig('metadata', 'finalizers') == ['resources-finalizer.argocd.argoproj.io'] &&
  app.dig('spec', 'source', 'path') == 'infra/helm/greenguard-opensearch' &&
  app.dig('spec', 'source', 'targetRevision') == values['revision']
abort 'OpenSearch image/bootstrap values drifted' unless
  app.dig('spec', 'source', 'helm', 'valuesObject') == {
    'image' => digest, 'bootstrap' => { 'enabled' => true, 'image' => digest }
  }

root_output, root_error, root_status = render.call('bootstrap-chart', values)
abort "root search render failed: #{root_error}" unless root_status.success?
root_app = YAML.load_stream(root_output).compact.fetch(0)
abort 'root lost search values' unless root_app.dig('spec', 'source', 'helm', 'valuesObject', 'searchPlane') == values.fetch('searchPlane')

%w[image bootstrapImage].each do |key|
  bad = Marshal.load(Marshal.dump(values))
  bad['searchPlane'][key] = 'mutable:latest'
  %w[applications-chart bootstrap-chart].each do |chart|
    _, _, invalid = render.call(chart, bad)
    abort "#{chart} accepted mutable #{key}" if invalid.success?
  end
end
bad = Marshal.load(Marshal.dump(values))
bad['searchPlane']['enabled'] = 'false'
%w[applications-chart bootstrap-chart].each do |chart|
  _, _, invalid = render.call(chart, bad)
  abort "#{chart} accepted string false" if invalid.success?
end
bad = Marshal.load(Marshal.dump(values))
bad['searchPlane']['enabled'] = false
disabled_output, disabled_error, disabled_status = render.call('applications-chart', bad)
abort "disabled search render failed: #{disabled_error}" unless disabled_status.success?
abort 'disabled search still rendered' if YAML.load_stream(disabled_output).compact.any? { |item| item.dig('metadata', 'name') == 'greenguard-opensearch' }

puts 'Search Argo child, ordering, pinned values, and reject fixtures pass.'
