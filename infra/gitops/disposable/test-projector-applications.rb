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
  'control-entitlement-projector' => ['tenant-control-plane', ['node', 'services/tenant-control-plane/dist/entitlements/projector.js'], nil],
  'entitlement-heartbeat' => ['device-service', ['node'], nil]
}
chart = File.expand_path('../../helm/greenguard-service', root)
releases = []
workers.each do |name, (image, command, registry)|
  release = contract.fetch('releases').find { |row| row['name'] == name }
  abort "#{name}: contract missing" unless release
  health_workers = %w[device-saga-worker device-tenant-projector control-entitlement-projector inventory-entitlement-projector read-entitlement-projector telemetry-entitlement-projector entitlement-heartbeat]
  expected_health = health_workers.include?(name) ? '/readyz' : nil
  abort "#{name}: separate image/principal/health drift" unless release['image'] == image && release['kafkaPrincipal'] == (name == 'entitlement-heartbeat' ? 'billing-service' : image) && release['health'] == expected_health
  extra = {'image' => digest, 'mesh' => {'enabled' => true, 'strictMtls' => true}, 'postgresReadReplica' => {'caSecretName' => 'greenguard-rds-ca'}}
  if name == 'device-saga-worker'
    extra['service'] = {'enabled' => false, 'port' => 8090, 'containerPort' => 8090}
    extra['container'] = {'env' => [{'name' => 'WORKER_HEALTH_PORT', 'value' => '8090'}]}
  elsif name == 'device-tenant-projector'
    extra['container'] = {'env' => [{'name' => 'INVENTORY_TENANT_PROJECTOR_HEALTH_PORT', 'value' => '8096'}]}
  elsif health_workers.include?(name) && name != 'telemetry-entitlement-projector'
    extra['service'] = {'enabled' => false, 'port' => 8090, 'containerPort' => 8090}
    extra['container'] = {'env' => [{'name' => 'WORKER_HEALTH_PORT', 'value' => '8090'}]}
  elsif name == 'telemetry-entitlement-projector'
    extra['service'] = {'enabled' => false, 'port' => 8090, 'containerPort' => 8090}
    extra['container'] = {'env' => [{'name' => 'TELEMETRY_ENTITLEMENT_PROJECTOR_HEALTH_ADDR', 'value' => '127.0.0.1:8090'}]}
  end
  if registry
    extra['container'] = (extra['container'] || {}).merge({
      'env' => (extra.dig('container', 'env') || []) + [{'name' => 'SHARD_REGISTRY_FILE', 'value' => '/run/greenguard-shards/registry.json'}],
      'volumeMounts' => [{'name' => 'shard-registry', 'mountPath' => '/run/greenguard-shards', 'readOnly' => true}]
    })
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
    abort "#{name}: worker unexpectedly has a Service" if docs.any? { |doc| doc['kind'] == 'Service' }
    if name == 'device-saga-worker'
      abort 'device saga worker must use broker/database readiness probes' unless
        container.dig('readinessProbe', 'httpGet', 'path') == '/readyz' &&
        container.dig('livenessProbe', 'httpGet', 'path') == '/healthz' &&
        container.dig('startupProbe', 'httpGet', 'path') == '/healthz' &&
        container.dig('ports', 0, 'containerPort') == 8090 &&
        container.fetch('env').any? { |env| env['name'] == 'WORKER_HEALTH_PORT' && env['value'] == '8090' }
    elsif name == 'device-tenant-projector'
      probes = %w[startupProbe readinessProbe livenessProbe]
      abort 'tenant projector probes must use its loopback Kafka-assignment health endpoints' unless
        probes.all? { |probe| container.dig(probe, 'exec', 'command')&.join(' ')&.include?('127.0.0.1:8096') } &&
        container.dig('ports', 0, 'containerPort') == 8096 &&
        container.fetch('env').any? { |env| env['name'] == 'INVENTORY_TENANT_PROJECTOR_HEALTH_PORT' && env['value'] == '8096' }
    elsif health_workers.include?(name)
      if name == 'telemetry-entitlement-projector'
        probes = %w[startupProbe readinessProbe livenessProbe]
        abort 'telemetry entitlement probes must use local assignment health' unless
          container.dig('startupProbe', 'exec', 'command') == ['/telemetry-ingest', 'probe', '/healthz', '127.0.0.1:8090'] &&
          container.dig('readinessProbe', 'exec', 'command') == ['/telemetry-ingest', 'probe', '/readyz', '127.0.0.1:8090'] &&
          container.dig('livenessProbe', 'exec', 'command') == ['/telemetry-ingest', 'probe', '/healthz', '127.0.0.1:8090'] &&
          container.fetch('env').any? { |env| env['name'] == 'TELEMETRY_ENTITLEMENT_PROJECTOR_HEALTH_ADDR' && env['value'] == '127.0.0.1:8090' }
      else
        probes = %w[startupProbe readinessProbe livenessProbe]
        abort "#{name}: probes must use loopback Kafka group assignment health" unless
          probes.all? { |probe| container.dig(probe, 'exec', 'command')&.join(' ')&.include?('127.0.0.1:8090') } &&
          container.fetch('env').any? { |env| env['name'] == 'WORKER_HEALTH_PORT' && env['value'] == '8090' }
      end
    else
      abort "#{name}: worker HTTP probes should remain disabled without a proven health signal" if container.key?('readinessProbe') || container.key?('livenessProbe') || container.key?('startupProbe')
    end
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
puts 'PASS worker workloads render with pinned images, scoped config/CA mounts, assignment-based entitlement readiness and owned Argo Applications'
