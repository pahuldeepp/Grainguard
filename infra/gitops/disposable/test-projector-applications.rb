#!/usr/bin/env ruby
require 'json'
require 'yaml'
require 'open3'
require 'tempfile'

root = __dir__
contract = JSON.parse(File.read(File.join(root, 'contract.json')))
terraform_gitops = File.read(File.expand_path('../../terraform/disposable/gitops.tf', root))
registry_block = terraform_gitops[/shard_registry_by_release\s*=\s*\{([\s\S]*?)\n\s*\}/, 1]
abort 'Terraform shard registry release map is missing' unless registry_block
terraform_registry_map = registry_block.scan(/"([a-z0-9-]+)"\s*=\s*\{\s*service\s*=\s*"([a-z0-9-]+)"\s*,\s*secret\s*=\s*"([a-z0-9-]+)"\s*,\s*env\s*=\s*"([A-Z_]+)"\s*\}/).to_h do |release, service, secret, env|
  [release, { 'service' => service, 'secret' => secret, 'env' => env }]
end
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
    mapping = terraform_registry_map.fetch(name) { abort "#{name}: Terraform shard registry mapping is missing" }
    abort "#{name}: Terraform shard registry target drift" unless mapping['secret'] == registry && mapping['env'] == 'SHARD_REGISTRY_FILE'
    extra['container'] = (extra['container'] || {}).merge({
      'env' => (extra.dig('container', 'env') || []) + [
        {'name' => 'SHARD_ROUTING_REQUIRED', 'value' => 'true'},
        {'name' => mapping.fetch('env'), 'value' => '/run/greenguard-shards/registry.json'}
      ],
      'volumeMounts' => [{'name' => 'shard-registry', 'mountPath' => '/run/greenguard-shards', 'readOnly' => true}]
    })
    extra['volumes'] = [{'name' => 'shard-registry', 'secret' => {'secretName' => "greenguard-shard-routing-#{registry}", 'defaultMode' => 288, 'items' => [{'key' => 'registry.json', 'path' => 'registry.json'}]}}]
  end
  Tempfile.create(['worker-', '.yaml']) do |file|
    file.write(extra.to_yaml); file.flush
    output, error, status = Open3.capture3('helm', 'template', name, chart, '--namespace', 'greenguard', '-f', File.join(chart, 'values', "#{name}.yaml"), '-f', file.path)
    abort "#{name}: Helm render failed #{error}" unless status.success?
    docs = YAML.load_stream(output).compact
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
    abort "#{name}: pod securityContext must allow the runtime UID to read group-readable projected Secrets" unless
      spec.dig('securityContext', 'runAsUser') == 101 && spec.dig('securityContext', 'fsGroup') == 101
    if registry
      secret = spec.fetch('volumes').find { |volume| volume['name'] == 'shard-registry' }.fetch('secret')
      abort "#{name}: registry role/permission drift" unless secret['secretName'] == "greenguard-shard-routing-#{mapping.fetch('secret')}" && secret['defaultMode'] == 288
      abort "#{name}: registry routing must fail closed" unless
        container.fetch('env').any? { |env| env['name'] == 'SHARD_ROUTING_REQUIRED' && env['value'] == 'true' } &&
        container.fetch('env').any? { |env| env['name'] == mapping.fetch('env') && env['value'] == '/run/greenguard-shards/registry.json' }
    end
    rds_ca = spec.fetch('volumes').find { |volume| volume['name'] == 'rds-ca' }
    abort "#{name}: missing RDS CA Secret/key mapping" unless
      rds_ca&.dig('secret', 'secretName') == 'greenguard-rds-ca' &&
      rds_ca.dig('secret', 'items') == [{'key' => 'ca.pem', 'path' => 'ca.pem'}]
  end
  releases << release.merge('imageDigest' => digest, 'extraValues' => extra.reject { |key, _| key == 'image' })
end
Tempfile.create(['worker-root-', '.yaml']) do |file|
  file.write({'cell' => 'offline-cell', 'repositoryUrl' => 'https://example.test/repo.git', 'revision' => 'b' * 40, 'releases' => releases, 'observabilityImages' => %w[otel-collector prometheus grafana tempo loki].to_h { |name| [name, digest] }}.to_yaml); file.flush
  output, error, status = Open3.capture3('helm', 'template', 'worker-root', File.join(root, 'applications-chart'), '-f', file.path)
  abort "worker Argo render failed #{error}" unless status.success?
  apps = YAML.load_stream(output).compact.select { |doc| workers.key?(doc.dig('spec', 'source', 'helm', 'releaseName')) }
  abort 'worker Argo release inventory incomplete' unless apps.length == workers.length
  apps.each do |app|
    abort 'worker lifecycle/order drift' unless app.dig('metadata', 'annotations', 'argocd.argoproj.io/sync-wave') == '30' && app.dig('metadata', 'finalizers') == ['resources-finalizer.argocd.argoproj.io']
    release_name = app.dig('spec', 'source', 'helm', 'releaseName')
    release = releases.find { |candidate| candidate.fetch('name') == release_name }
    rendered_values = app.dig('spec', 'source', 'helm', 'valuesObject')
    abort "#{release_name}: Argo Application lost chart valuesObject" unless rendered_values
    expected_values = release.fetch('extraValues')
    abort "#{release_name}: Argo Application did not preserve runtime container env/mounts" unless
      rendered_values['container'] == expected_values['container']
    if expected_values['volumes']
      abort "#{release_name}: Argo Application did not preserve Secret volumes" unless
        rendered_values['volumes'] == expected_values['volumes']
    end
  end
end
puts 'PASS worker workloads render with pinned images, scoped config/CA mounts, assignment-based entitlement readiness and owned Argo Applications'
