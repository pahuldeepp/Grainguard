#!/usr/bin/env ruby
require 'yaml'
require 'open3'

root = __dir__
chart = File.join(root, 'owner-migrations-chart')
_, _, default_status = Open3.capture3('helm', 'template', 'owner-migrations', chart)
abort 'owner migration chart accepted missing images' if default_status.success?

images = {
  'telemetryImage' => "example.test/telemetry-migrate@sha256:#{'a' * 64}",
  'projectionImage' => "example.test/projection-migrate@sha256:#{'b' * 64}",
  'jobsImage' => "example.test/jobs-migrate@sha256:#{'c' * 64}",
  'sagaImage' => "example.test/saga-migrate@sha256:#{'d' * 64}",
  'hardwareImage' => "example.test/hardware-migrate@sha256:#{'e' * 64}",
  'inventoryImage' => "example.test/inventory-migrate@sha256:#{'f' * 64}",
  'alertsImage' => "example.test/alerts-migrate@sha256:#{'1' * 64}",
  'controlImage' => "example.test/control-migrate@sha256:#{'2' * 64}",
  'billingImage' => "example.test/billing-migrate@sha256:#{'3' * 64}",
  'riskImage' => "example.test/risk-migrate@sha256:#{'4' * 64}",
  'notificationsImage' => "example.test/notifications-migrate@sha256:#{'5' * 64}"
}
args = images.flat_map { |key, value| ['--set-string', "#{key}=#{value}"] }
rendered, error, status = Open3.capture3('helm', 'template', 'owner-migrations', chart, *args)
abort "owner migration chart failed: #{error}" unless status.success?
jobs = YAML.safe_load_stream(rendered).compact
abort 'expected exactly eleven owner migration Jobs' unless jobs.length == 11 && jobs.all? { |job| job['kind'] == 'Job' }
expected = {
  'telemetry' => 'TELEMETRY_MIGRATION_URL',
  'projection' => 'PROJECTION_MIGRATION_URL',
  'jobs' => 'JOBS_MIGRATION_URL',
  'saga' => 'SAGA_MIGRATION_URL',
  'hardware' => 'HARDWARE_MIGRATION_URL',
  'inventory' => 'INVENTORY_MIGRATION_URL',
  'alerts' => 'ALERTS_MIGRATION_URL',
  'control' => 'CONTROL_MIGRATION_URL',
  'billing' => 'BILLING_MIGRATION_URL',
  'risk' => 'RISK_MIGRATION_URL',
  'notifications' => 'NOTIFICATIONS_MIGRATION_URL'
}
expected.each do |owner, key|
  job = jobs.find { |candidate| candidate.dig('metadata', 'name').start_with?("greenguard-#{owner}-migrate-") }
  abort "#{owner} Job missing" unless job
  pod = job.dig('spec', 'template', 'spec')
  container = pod.fetch('containers').fetch(0)
  abort "#{owner} image is mutable" unless container.fetch('image').match?(/@sha256:[a-f0-9]{64}\z/)
  abort "#{owner} RDS TLS guard missing" unless container.fetch('env').any? { |entry| entry['name'] == 'GG_RDS' && entry['value'] == '1' }
  abort "#{owner} owner credential missing" unless container.fetch('env').any? { |entry| entry['name'] == key && entry.dig('valueFrom', 'secretKeyRef', 'key') == key }
  abort "#{owner} CA Secret missing" unless pod.fetch('volumes').any? { |volume| volume.dig('secret', 'secretName') == 'greenguard-rds-ca' }
  abort "#{owner} Job unbounded" unless job.dig('spec', 'activeDeadlineSeconds').to_i.positive? && job.dig('spec', 'backoffLimit').to_i == 1
end

%w[inventory alerts control billing notifications].each do |owner|
  job = jobs.find { |candidate| candidate.dig('metadata', 'name').start_with?("greenguard-#{owner}-migrate-") }
  pod = job.dig('spec', 'template', 'spec')
  abort "#{owner} Prisma user drift" unless pod.dig('securityContext', 'runAsUser') == 1000
  abort "#{owner} writable tmp missing" unless pod.fetch('volumes').any? { |volume| volume['name'] == 'tmp' && volume['emptyDir']['sizeLimit'] == '128Mi' }
  abort "#{owner} npm home missing" unless pod.fetch('containers').fetch(0).fetch('env').any? { |entry| entry['name'] == 'HOME' && entry['value'] == '/tmp' }
end

risk_job = jobs.find { |candidate| candidate.dig('metadata', 'name').start_with?('greenguard-risk-migrate-') }
abort 'risk Python UID drift' unless risk_job.dig('spec', 'template', 'spec', 'securityContext', 'runAsUser') == 10001

%w[telemetry-ingest projection-builder jobs-worker saga-orchestrator hardware-service].each do |service|
  dockerfile = File.read(File.join(root, "../../../services/#{service}/Dockerfile"))
  abort "#{service} migration image target missing" unless dockerfile.include?('FROM scratch AS migration') && dockerfile.include?('FROM scratch AS runtime')
end

%w[device-service workflow-alerts tenant-control-plane billing-service notification-service].each do |service|
  dockerfile = File.read(File.join(root, "../../../services/#{service}/Dockerfile"))
  abort "#{service} Prisma migration image target missing" unless dockerfile.include?('FROM build AS migration') && dockerfile.include?('FROM build AS production-deps') && dockerfile.include?('AS runtime') && dockerfile.include?('verify-migration-url.mjs')
end

risk_dockerfile = File.read(File.join(root, '../../../services/risk-engine/Dockerfile'))
abort 'risk Python migration image target missing' unless risk_dockerfile.include?('FROM base AS migration') && risk_dockerfile.include?('FROM base AS runtime') && risk_dockerfile.include?('verify-migration-url.py')

_, _, gate_status = Open3.capture3('helm', 'template', 'migration-gate', File.join(root, 'migration-gate-chart'))
abort 'full owner migration gate failed open' if gate_status.success?
puts 'Eleven PostgreSQL owner migration images/Jobs render only with digests; RDS TLS and full migration gates remain closed.'
