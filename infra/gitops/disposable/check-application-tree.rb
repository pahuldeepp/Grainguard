#!/usr/bin/env ruby
require 'json'
require 'yaml'
require 'open3'
require 'tempfile'

root = __dir__
controllers = File.read(File.join(root, '../../terraform/disposable/controllers.tf'))
abort 'Argo child Application health customization missing' unless
  controllers.include?('resource.customizations.health.argoproj.io_Application') &&
  controllers.include?('hs.status = "Progressing"')

data_rendered, data_error, data_status = Open3.capture3('kubectl', 'kustomize', File.join(root, '../../kubernetes/disposable-data'))
abort "data Kustomize failed: #{data_error}" unless data_status.success?
data_objects = YAML.safe_load_stream(data_rendered).compact
abort 'Schema Registry must not gate broker bootstrap wave' if data_objects.any? { |object| object.dig('metadata', 'name') == 'schema-registry' }
registry_rendered, registry_error, registry_status = Open3.capture3('kubectl', 'kustomize', File.join(root, '../../kubernetes/disposable-data/registry'))
abort "Registry Kustomize failed: #{registry_error}" unless registry_status.success?
registry_objects = YAML.safe_load_stream(registry_rendered).compact
abort 'Registry child must own Service and Deployment only' unless registry_objects.map { |object| [object['kind'], object.dig('metadata', 'name')] }.sort == [['Deployment', 'schema-registry'], ['Service', 'schema-registry']]
quarantine_claim = data_objects.find { |object| object['kind'] == 'PersistentVolumeClaim' && object.dig('metadata', 'name') == 'search-indexer-quarantine' }
abort 'search-indexer claim must not deadlock data health before its consumer starts' unless
  quarantine_claim&.dig('metadata', 'annotations', 'argocd.argoproj.io/ignore-healthcheck') == 'true'

contract = JSON.parse(File.read(File.join(root, 'contract.json')))
releases = contract.fetch('releases')
digest = "123456789012.dkr.ecr.us-east-1.amazonaws.com/greenguard/example@sha256:#{'a' * 64}"
values = {
  'cell' => 'greenguard-example',
  'repositoryUrl' => 'https://github.com/pahuldeepp/Grainguard.git',
  'revision' => 'b' * 40,
  'observabilityImages' => %w[otel-collector prometheus grafana tempo loki].to_h { |name| [name, digest] },
  'ownerMigrations' => {
    'revision' => 'b' * 40,
    'images' => %w[control billing telemetry projection jobs saga hardware inventory alerts risk notifications].to_h { |name| [name, digest] },
    'gateImage' => digest,
    'sqlImage' => digest,
    'caSecret' => 'greenguard-rds-ca',
    'rdsCIDRs' => %w[10.60.128.0/20 10.60.144.0/20],
    'apiServerCIDR' => '10.100.0.1/32',
    'scopes' => {
      'central' => {
        'rdsHost' => 'central.example.rds.amazonaws.com',
        'secrets' => { 'control' => 'greenguard-control-migration', 'billing' => 'greenguard-billing-migration' }
      },
      **%w[s1 s2 s3 s4].to_h do |shard|
        [shard, {
          'rdsHost' => "#{shard}.example.rds.amazonaws.com",
          'secrets' => %w[telemetry projection jobs saga hardware inventory alerts risk notifications].to_h do |owner|
            [owner, "greenguard-#{shard}-#{owner}-migration"]
          end
        }]
      end
    }
  },
  'releases' => releases.map do |release|
    extra = case release.fetch('name')
            when 'dashboard'
              { 'publicOidc' => { 'enabled' => true,
                                  'authority' => 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Test',
                                  'clientId' => 'public-web-client', 'tokenMode' => 'cognito-access',
                                  'audience' => '', 'resource' => '',
                                  'connectOrigins' => ['https://gg-test.auth.us-east-1.amazoncognito.com'] } }
            when 'bff'
              { 'env' => [{ 'name' => 'AUTH_TOKEN_MODE', 'value' => 'cognito-access' }],
                'envFrom' => [{ 'secretRef' => { 'name' => 'bff-config' } }] }
            when 'gateway'
              { 'container' => {
                'env' => [{ 'name' => 'AUTH_MEMBERSHIP_SOURCE', 'value' => 'control-plane' }],
                'envFrom' => [{ 'secretRef' => { 'name' => 'gateway-config' } }]
              } }
            else
              {}
            end
    extra['mesh'] = { 'enabled' => true, 'strictMtls' => true }
    { 'name' => release.fetch('name'), 'chart' => release.fetch('chart'),
      'profile' => release['profile'], 'imageDigest' => digest,
      'extraValues' => extra }
  end
}

Tempfile.create(['greenguard-apps-', '.yaml']) do |file|
  file.write(values.to_yaml)
  file.flush
  chart = File.join(root, 'applications-chart')
  rendered, error, status = Open3.capture3('helm', 'template', 'applications', chart, '--namespace', 'argocd', '-f', file.path)
  abort "application chart failed: #{error}" unless status.success?
  apps = YAML.safe_load_stream(rendered).compact
  actual = apps.map { |app| app.fetch('metadata').fetch('name').delete_prefix('greenguard-') }
  expected = releases.map { |release| release.fetch('name') } + ['disposable-data', 'observability', 'rds-bootstrap', 'owner-migrations', 'migration-gate']
  abort "application inventory drift: #{actual.sort} != #{expected.sort}" unless actual.sort == expected.sort
  apps.each do |app|
    spec = app.fetch('spec')
    source = spec.fetch('source')
    abort 'mutable Git revision' unless source.fetch('targetRevision') == values.fetch('revision')
    if app.fetch('metadata').fetch('name') == 'greenguard-disposable-data'
      abort 'data Application source drift' unless source.fetch('path') == 'infra/kubernetes/disposable-data'
      abort 'data Application sync wave drift' unless app.fetch('metadata').fetch('annotations').fetch('argocd.argoproj.io/sync-wave') == '10'
    elsif app.fetch('metadata').fetch('name') == 'greenguard-schema-registry'
      abort 'Registry Application source drift' unless source.fetch('path') == 'infra/kubernetes/disposable-data/registry'
      abort 'Registry must follow ACL/topic bootstrap' unless app.fetch('metadata').fetch('annotations').fetch('argocd.argoproj.io/sync-wave') == '13'
    elsif app.fetch('metadata').fetch('name') == 'greenguard-observability'
      abort 'observability Application source drift' unless source.fetch('path') == 'infra/gitops/disposable/observability-chart'
      abort 'observability Application sync wave drift' unless app.fetch('metadata').fetch('annotations').fetch('argocd.argoproj.io/sync-wave') == '15'
      abort 'observability images missing' unless source.dig('helm', 'valuesObject', 'images') == values.fetch('observabilityImages')
    elsif app.fetch('metadata').fetch('name') == 'greenguard-rds-bootstrap'
      abort 'RDS bootstrap Application source drift' unless source.fetch('path') == 'infra/gitops/disposable/rds-bootstrap-chart'
      abort 'RDS bootstrap Application sync wave drift' unless app.fetch('metadata').fetch('annotations').fetch('argocd.argoproj.io/sync-wave') == '20'
    elsif app.fetch('metadata').fetch('name') == 'greenguard-migration-gate'
      abort 'migration gate Application source drift' unless source.fetch('path') == 'infra/gitops/disposable/migration-gate-chart'
      abort 'migration gate Application sync wave drift' unless app.fetch('metadata').fetch('annotations').fetch('argocd.argoproj.io/sync-wave') == '25'
    elsif app.fetch('metadata').fetch('name') == 'greenguard-owner-migrations'
      abort 'owner migration Application source drift' unless source.fetch('path') == 'infra/gitops/disposable/owner-migrations-chart'
      abort 'owner migration Application sync wave drift' unless app.fetch('metadata').fetch('annotations').fetch('argocd.argoproj.io/sync-wave') == '24'
      abort 'owner migration contract was not propagated' unless source.dig('helm', 'valuesObject') == values.fetch('ownerMigrations')
    else
      object = source.fetch('helm').fetch('valuesObject')
      abort 'mutable image' unless object.fetch('image') == digest
      abort 'runtime mesh must be enabled with strict mTLS' unless object.dig('mesh', 'enabled') == true && object.dig('mesh', 'strictMtls') == true
      case app.fetch('metadata').fetch('name')
      when 'greenguard-dashboard'
        abort 'web OIDC values missing' unless object.dig('publicOidc', 'tokenMode') == 'cognito-access'
      when 'greenguard-bff'
        abort 'BFF OIDC values missing' unless object.fetch('env').any? { |v| v['name'] == 'AUTH_TOKEN_MODE' } &&
          object.dig('envFrom', 0, 'secretRef', 'name') == 'bff-config'
      when 'greenguard-gateway'
        abort 'gateway membership values missing' unless object.dig('container', 'env', 0, 'value') == 'control-plane' &&
          object.dig('container', 'envFrom', 0, 'secretRef', 'name') == 'gateway-config'
      end
      abort 'application sync wave drift' unless app.fetch('metadata').fetch('annotations').fetch('argocd.argoproj.io/sync-wave') == '30'
    end
    abort 'wrong destination namespace' unless spec.fetch('destination').fetch('namespace') == 'greenguard'
    abort 'missing cell ownership label' unless app.fetch('metadata').fetch('labels').fetch('greenguard.io/cell') == values.fetch('cell')
  end
  root_rendered, root_error, root_status = Open3.capture3('helm', 'template', 'bootstrap', File.join(root, 'bootstrap-chart'), '--namespace', 'argocd', '-f', file.path)
  abort "bootstrap chart failed: #{root_error}" unless root_status.success?
  root_app = YAML.safe_load_stream(root_rendered).compact.fetch(0)
  abort 'root does not point to applications chart' unless root_app.fetch('spec').fetch('source').fetch('path') == 'infra/gitops/disposable/applications-chart'
  abort 'root does not pass every release' unless root_app.fetch('spec').fetch('source').fetch('helm').fetch('valuesObject').fetch('releases').length == releases.length
  abort 'root does not pass the owner migration contract' unless root_app.fetch('spec').fetch('source').fetch('helm').fetch('valuesObject').fetch('ownerMigrations') == values.fetch('ownerMigrations')
  reject_values = values.merge('revision' => 'main')
  file.rewind
  file.truncate(0)
  file.write(reject_values.to_yaml)
  file.flush
  _, _, rejected = Open3.capture3('helm', 'template', 'bootstrap', File.join(root, 'bootstrap-chart'), '--namespace', 'argocd', '-f', file.path)
  abort 'mutable Git branch was accepted' if rejected.success?
  port_values = values.merge('releases' => values.fetch('releases').map(&:dup))
  port_values.fetch('releases').first['imageDigest'] = "registry.example:5000/greenguard/example@sha256:#{'a' * 64}"
  file.rewind
  file.truncate(0)
  file.write(port_values.to_yaml)
  file.flush
  _, port_error, port_status = Open3.capture3('helm', 'template', 'applications', chart, '--namespace', 'argocd', '-f', file.path)
  abort "digest registry port was rejected: #{port_error}" unless port_status.success?
  override_values = values.merge('releases' => values.fetch('releases').map(&:dup))
  override_values.fetch('releases').first['extraValues'] = { 'image' => 'mutable:latest' }
  file.rewind
  file.truncate(0)
  file.write(override_values.to_yaml)
  file.flush
  _, _, overridden = Open3.capture3('helm', 'template', 'applications', chart, '--namespace', 'argocd', '-f', file.path)
  abort 'extraValues.image overrode the pinned digest' if overridden.success?
  %w[greenguard-dashboard greenguard-bff greenguard-service].each do |chart_name|
    chart_path = File.join(root, '../../helm', chart_name)
    args = ['helm', 'template', 'mesh-check', chart_path, '--namespace', 'greenguard',
            '--set', 'mesh.enabled=true', '--set', 'mesh.strictMtls=true',
            '--set', "image=#{digest}"]
    args += ['--set', 'profile=api'] if chart_name == 'greenguard-service'
    mesh_rendered, mesh_error, mesh_status = Open3.capture3(*args)
    abort "#{chart_name} strict-mesh render failed: #{mesh_error}" unless mesh_status.success?
    mesh_objects = YAML.safe_load_stream(mesh_rendered).compact
    abort "#{chart_name} lacks STRICT PeerAuthentication" unless mesh_objects.any? { |item|
      item['kind'] == 'PeerAuthentication' && item.dig('spec', 'mtls', 'mode') == 'STRICT'
    }
    abort "#{chart_name} lacks injected Envoy sidecar" unless mesh_objects.any? { |item|
      item['kind'] == 'Deployment' && item.dig('spec', 'template', 'metadata', 'labels', 'sidecar.istio.io/inject') == 'true'
    }
  end
puts "Argo CD tree renders #{releases.length} digest-pinned runtime Applications plus data, observability, RDS bootstrap, 38-owner migration Jobs, and SQL migration gate Applications."
end
