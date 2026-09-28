#!/usr/bin/env ruby
require 'json'
require 'yaml'
require 'open3'
require 'tempfile'

root = __dir__
contract = JSON.parse(File.read(File.join(root, 'contract.json')))
digest = "example.test/greenguard/runtime@sha256:#{'a' * 64}"
workers = {
  'device-saga-worker' => ['device-service', ['node', 'services/device-service/dist/saga/main.js'], 'device-service'],
  'device-tenant-projector' => ['device-service', ['node', 'services/device-service/dist/tenant-projection/main.js'], 'inventory-projector'],
  'inventory-entitlement-projector' => ['device-service', ['node', 'services/device-service/dist/entitlements/projector.js'], 'inventory-projector'],
  'telemetry-entitlement-projector' => ['telemetry-ingest', ['/telemetry-ingest', 'entitlement-projector'], 'telemetry-entitlement-projector'],
  'read-entitlement-projector' => ['read-api', ['node', 'services/read-api/dist/entitlements/projector.js'], 'read-entitlement-projector'],
  'control-entitlement-projector' => ['tenant-control-plane', ['node', 'services/tenant-control-plane/dist/entitlements/projector.js'], nil]
}
chart = File.expand_path('../../helm/greenguard-service', root)
releases = []
workers.each do |name, (image, command, registry)|
  release = contract.fetch('releases').find { |row| row['name'] == name }
  abort "#{name}: contract missing" unless release
  abort "#{name}: separate image/principal drift" unless release['image'] == image && release['kafkaPrincipal'] == image && release['health'].nil?
  extra = {'image' => digest, 'mesh' => {'enabled' => true, 'strictMtls' => true}, 'postgresReadReplica' => {'caSecretName' => 'greenguard-rds-ca'}}
  if registry
    extra['container'] = {
      'env' => [{'name' => 'SHARD_REGISTRY_FILE', 'value' => '/run/greenguard-shards/registry.json'}],
      'volumeMounts' => [{'name' => 'shard-registry', 'mountPath' => '/run/greenguard-shards', 'readOnly' => true}]
    }
    extra['volumes'] = [{'name' => 'shard-registry', 'secret' => {'secretName' => "greenguard-shard-routing-#{registry}", 'defaultMode' => 256, 'items' => [{'key' => 'registry.json', 'path' => 'registry.json'}]}}]
  end
  Tempfile.create(['worker-', '.yaml']) do |file|
    file.write(extra.to_yaml); file.flush
    output, error, status = Open3.capture3('helm', 'template', name, chart, '--namespace', 'greenguard', '-f', File.join(chart, 'values', "#{name}.yaml"), '-f', file.path)
    abort "#{name}: Helm render failed #{error}" unless status.success?
    docs = YAML.safe_load_stream(output).compact
    deployment = docs.find { |doc| doc['kind'] == 'Deployment' }
    abort "#{name}: no deployment" unless deployment
    spec = deployment.dig('spec', 'template', 'spec')
    container = spec.fetch('containers').first
    abort "#{name}: wrong executable" unless container['command'] == command
    abort "#{name}: wrong runtime config" unless container['envFrom'] == [{'secretRef' => {'name' => release['secret']}}]
    abort "#{name}: worker has HTTP probes or Service" if container.key?('readinessProbe') || container.key?('livenessProbe') || container.key?('startupProbe') || docs.any? { |doc| doc['kind'] == 'Service' }
    abort "#{name}: missing verified RDS CA mount" unless container['volumeMounts'].any? { |mount| mount['name'] == 'rds-ca' && mount['readOnly'] == true }
    if registry
      secret = spec.fetch('volumes').find { |volume| volume['name'] == 'shard-registry' }.fetch('secret')
      abort "#{name}: registry role/permission drift" unless secret['secretName'] == "greenguard-shard-routing-#{registry}" && secret['defaultMode'] == 256
    end
  end
  releases << release.merge('imageDigest' => digest, 'extraValues' => extra.reject { |key, _| key == 'image' })
end
Tempfile.create(['worker-root-', '.yaml']) do |file|
  file.write({'cell' => 'offline-cell', 'repositoryUrl' => 'https://example.test/repo.git', 'revision' => 'b' * 40, 'releases' => releases, 'observabilityImages' => %w[otel-collector prometheus grafana tempo loki].to_h { |name| [name, digest] }}.to_yaml); file.flush
  output, error, status = Open3.capture3('helm', 'template', 'worker-root', File.join(root, 'applications-chart'), '-f', file.path)
  abort "worker Argo render failed #{error}" unless status.success?
  apps = YAML.safe_load_stream(output).compact.select { |doc| workers.key?(doc.dig('spec', 'source', 'helm', 'releaseName')) }
  abort 'worker Argo release inventory incomplete' unless apps.length == workers.length
  apps.each do |app|
    abort 'worker lifecycle/order drift' unless app.dig('metadata', 'annotations', 'argocd.argoproj.io/sync-wave') == '30' && app.dig('metadata', 'finalizers') == ['resources-finalizer.argocd.argoproj.io']
  end
end
puts 'PASS 6 missing worker workloads render with pinned reused images, scoped registry/config/CA mounts, no HTTP probes and owned Argo Applications; read projector uses its dedicated writer role registry'
