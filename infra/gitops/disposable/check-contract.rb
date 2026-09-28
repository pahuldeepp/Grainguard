#!/usr/bin/env ruby
# Offline deployment-contract check. Passing does not imply an AWS deployment.
require 'json'
require 'yaml'
abort 'usage: check-contract.rb [--ready]' unless ARGV.empty? || ARGV == ['--ready']
root = File.expand_path('../../..', __dir__)
contract = JSON.parse(File.read(File.join(__dir__, 'contract.json')))
abort 'unsupported contract schema' unless contract['schemaVersion'] == 1
phases = contract.fetch('phases').map { |p| p.fetch('id') }
abort 'unsafe deployment phase order' unless phases == %w[controllers data migrations applications acceptance]
abort 'blocking gaps must remain explicit until closed' if contract.fetch('blockingGaps').empty?
observability_names = %w[otel opentelemetry prometheus grafana tempo loki]
controller_source = File.read(File.join(root, 'infra/terraform/disposable/controllers.tf'))
gitops_source = File.read(File.join(root, 'infra/terraform/disposable/gitops.tf'))
owned_observability = observability_names.all? do |name|
  controller_source.match?(/resource\s+"helm_release"\s+"[^"]*#{name}[^"]*"/) ||
    contract.fetch('releases').any? { |release| release.fetch('name').include?(name) }
end
runtime_export_wired = gitops_source.match?(/name\s*=\s*"OTEL_EXPORTER_OTLP_ENDPOINT"/)
chart_telemetry_enabled = %w[greenguard-service greenguard-bff greenguard-dashboard].all? do |chart|
  values = YAML.safe_load_file(File.join(root, 'infra/helm', chart, 'values.yaml'))
  values.dig('observability', 'prometheus', 'enabled') == true &&
    values.dig('observability', 'collector', 'enabled') == true
end
unless owned_observability && runtime_export_wired && chart_telemetry_enabled
  abort 'unowned or unwired Stage 11 observability must remain a blocking gap' unless
    contract.fetch('blockingGaps').any? { |gap| gap.include?('Stage 11 observability') }
end
releases = contract.fetch('releases')
names = releases.map { |r| r.fetch('name') }
abort 'duplicate release' unless names.uniq == names
images = releases.map { |r| r.fetch('image') }.uniq
expected_images = %w[dashboard bff gateway device-service read-api workflow-alerts telemetry-ingest cdc-transformer projection-builder cache-invalidator risk-engine hardware-service eventbridge-bridge saga-orchestrator tenant-control-plane billing-service notification-service jobs-worker cassandra-writer search-indexer]
abort 'published image coverage drifted' unless images.sort == expected_images.sort
releases.each do |release|
  abort "#{release['name']}: invalid phase" unless release.fetch('phase') == 'applications'
  chart = release.fetch('chart')
  abort "#{release['name']}: invalid chart" unless %w[greenguard-dashboard greenguard-bff greenguard-service].include?(chart)
  chart_path = File.join(root, 'infra/helm', chart)
  abort "#{release['name']}: missing chart" unless File.file?(File.join(chart_path, 'Chart.yaml'))
  if chart == 'greenguard-service'
    profile = release.fetch('profile')
    abort "#{release['name']}: missing profile" unless File.file?(File.join(chart_path, 'values', "#{profile}.yaml"))
  end
  abort "#{release['name']}: missing secret contract" unless release.fetch('secret').match?(/\A[a-z0-9-]+\z/)
end
puts "Disposable contract structure valid: #{releases.length} releases, #{images.length} images, #{contract['blockingGaps'].length} blocking gaps."
if ARGV == ['--ready']
  abort "Deployment is blocked:\n- #{contract['blockingGaps'].join("\n- ")}" unless contract['blockingGaps'].empty?
  abort 'deployment inputs and live dependency checks are not implemented'
end
