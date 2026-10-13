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
data_objects = YAML.load_stream(data_rendered).compact
abort 'Schema Registry must not gate broker bootstrap wave' if data_objects.any? { |object| object.dig('metadata', 'name') == 'schema-registry' }
registry_rendered, registry_error, registry_status = Open3.capture3('kubectl', 'kustomize', File.join(root, '../../kubernetes/disposable-data/registry'))
abort "Registry Kustomize failed: #{registry_error}" unless registry_status.success?
registry_objects = YAML.load_stream(registry_rendered).compact
abort 'Registry child must own Service and Deployment only' unless registry_objects.map { |object| [object['kind'], object.dig('metadata', 'name')] }.sort == [['Deployment', 'schema-registry'], ['Service', 'schema-registry']]
quarantine_claim = data_objects.find { |object| object['kind'] == 'PersistentVolumeClaim' && object.dig('metadata', 'name') == 'search-indexer-quarantine' }
abort 'search-indexer claim must not deadlock data health before its consumer starts' unless
  quarantine_claim&.dig('metadata', 'annotations', 'argocd.argoproj.io/ignore-healthcheck') == 'true'

contract = JSON.parse(File.read(File.join(root, 'contract.json')))
releases = contract.fetch('releases')
shard_routed_releases = %w[
  device-service telemetry-ingest projection-builder risk-engine workflow-alerts jobs-worker
  notification-service saga-api saga-worker hardware-service-worker tenant-control-plane read-api
  audit-export-worker device-saga-worker device-tenant-projector inventory-entitlement-projector
  telemetry-entitlement-projector read-entitlement-projector
]
digest = "123456789012.dkr.ecr.us-east-1.amazonaws.com/greenguard/example@sha256:#{'a' * 64}"
values = {
  'cell' => 'greenguard-example',
  'repositoryUrl' => 'ssh://git@github.com/pahuldeepp/Grainguard.git',
  'revision' => 'b' * 40,
  'edgeRouting' => { 'enabled' => true, 'accountId' => '123456789012', 'region' => 'us-east-1', 'targetGroupARN' => 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/ggmesh-example/0123456789abcdef' },
  'managedDex' => {
    'enabled' => true,
    'image' => "ghcr.io/dexidp/dex:v2.41.1@sha256:#{'f' * 64}",
    'issuer' => 'https://api.example.cloudfront.net/dex',
    'webOrigin' => 'https://app.example.cloudfront.net',
    'databaseHost' => 'central.example.rds.amazonaws.com',
    'databaseCIDRs' => %w[10.60.128.0/20 10.60.144.0/20],
    'secret' => 'greenguard-dex-config',
    'caSecret' => 'greenguard-rds-ca'
  },
  'acceptanceProbes' => {
    'enabled' => true,
    'membershipEnabled' => false,
    'clickhouseImage' => digest,
    'tenantControlPlaneImage' => digest,
    'membershipAudience' => 'greenguard-dashboard'
  },
  'dataPlane' => {'enabled' => true, 'rdsHost' => 'central.example.rds.amazonaws.com', 'images' => %w[pgbouncer kafka-topics kafka-connect connector-registration redis].to_h { |name| [name, digest] }, 'secrets' => {'pgbouncerAuth' => 'greenguard-pgbouncer-auth', 'rdsCa' => 'greenguard-rds-ca', 'cdcCredentials' => 'greenguard-cdc-credentials'}},
  'searchPlane' => {'enabled' => true, 'image' => digest, 'bootstrapImage' => digest},
  'cassandraPlane' => {'enabled' => true, 'image' => digest, 'migratorImage' => digest, 'authSecret' => 'greenguard-cassandra-auth', 'tlsSecret' => 'greenguard-cassandra-tls', 'apiServerCIDR' => '10.100.0.1/32'},
  'observabilityImages' => %w[otel-collector prometheus grafana tempo loki].to_h { |name| [name, digest] },
  'clickhousePlane' => {'enabled' => true, 'image' => digest, 'storageClassName' => 'gp3', 'storageSize' => '20Gi', 'authSecret' => 'greenguard-telemetry-clickhouse-config', 'replayS3CIDRs' => %w[52.216.0.0/15 3.5.0.0/20]},
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
    shard_routing_required = shard_routed_releases.include?(release.fetch('name'))
    if shard_routing_required
      extra['container'] ||= {}
      extra['container']['env'] = Array(extra['container']['env']) + [
        { 'name' => 'SHARD_ROUTING_REQUIRED', 'value' => 'true' }
      ]
    end
    extra['mesh'] = { 'enabled' => true, 'strictMtls' => true }
    { 'name' => release.fetch('name'), 'chart' => release.fetch('chart'),
      'profile' => release['profile'], 'imageDigest' => digest,
      'shardRoutingRequired' => shard_routing_required,
      'extraValues' => extra }
  end
}

Tempfile.create(['greenguard-apps-', '.yaml']) do |file|
  file.write(values.to_yaml)
  file.flush
  # Exercise the actual Terraform bootstrap -> root Application -> child chart
  # path, so a value discarded by the bootstrap chart cannot pass this gate.
  bootstrap, bootstrap_error, bootstrap_status = Open3.capture3('helm', 'template', 'bootstrap', File.join(root, 'bootstrap-chart'), '--namespace', 'argocd', '-f', file.path)
  abort "bootstrap chart failed: #{bootstrap_error}" unless bootstrap_status.success?
  root_application = YAML.load_stream(bootstrap).compact.find { |object| object['kind'] == 'Application' }
  propagated = root_application.dig('spec', 'source', 'helm', 'valuesObject')
  abort 'ClickHouse configuration discarded by bootstrap' unless propagated['clickhousePlane'] == values['clickhousePlane']
  abort 'edge routing configuration discarded by bootstrap' unless propagated['edgeRouting'] == values['edgeRouting']
  file.rewind
  file.truncate(0)
  file.write(propagated.to_yaml)
  file.flush
  chart = File.join(root, 'applications-chart')
  rendered, error, status = Open3.capture3('helm', 'template', 'applications', chart, '--namespace', 'argocd', '-f', file.path)
  abort "application chart failed: #{error}" unless status.success?
  apps = YAML.load_stream(rendered).compact
  actual = apps.map { |app| app.fetch('metadata').fetch('name').delete_prefix('greenguard-') }
  expected = releases.map { |release| release.fetch('name') } + ['pgbouncer', 'kafka-topics', 'schema-registry', 'kafka-connect', 'connector-registration', 'opensearch', 'cassandra', 'disposable-data', 'observability', 'rds-bootstrap', 'owner-migrations', 'migration-gate', 'clickhouse', 'edge-routing', 'managed-dex', 'live-acceptance-probes']
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
    elsif app.fetch('metadata').fetch('name') == 'greenguard-edge-routing'
      abort 'edge routing Application source drift' unless source.fetch('path') == 'infra/gitops/disposable/edge-routing-chart'
      abort 'edge must follow application readiness' unless app.fetch('metadata').fetch('annotations').fetch('argocd.argoproj.io/sync-wave') == '40'
      edge_expected = values.fetch('edgeRouting').reject { |key, _| key == 'enabled' }.merge('cell' => values.fetch('cell'), 'dexEnabled' => true)
      abort 'edge AWS ownership scope was discarded' unless source.dig('helm', 'valuesObject') == edge_expected
    elsif app.fetch('metadata').fetch('name') == 'greenguard-managed-dex'
      abort 'managed Dex Application source drift' unless source.fetch('path') == 'infra/gitops/disposable/dex-chart'
      abort 'managed Dex must sync before the readiness probes' unless app.fetch('metadata').fetch('annotations').fetch('argocd.argoproj.io/sync-wave') == '21'
      dex_values = source.dig('helm', 'valuesObject')
      abort 'managed Dex issuer or storage scope was discarded' unless dex_values['issuer'] == values.dig('managedDex', 'issuer') && dex_values['databaseHost'] == values.dig('managedDex', 'databaseHost')
    elsif app.fetch('metadata').fetch('name') == 'greenguard-live-acceptance-probes'
      abort 'acceptance probe Application source drift' unless source.fetch('path') == 'infra/gitops/disposable/acceptance-probes-chart'
      abort 'acceptance probes must run after stateful services' unless app.fetch('metadata').fetch('annotations').fetch('argocd.argoproj.io/sync-wave') == '29'
      probe_values = source.dig('helm', 'valuesObject')
      abort 'membership probe must remain gated until interactive login' unless probe_values['membershipEnabled'] == false
      abort 'acceptance probe image or audience was discarded' unless probe_values['clickhouseImage'] == values.dig('acceptanceProbes', 'clickhouseImage') && probe_values['membershipAudience'] == values.dig('acceptanceProbes', 'membershipAudience')
    elsif app.fetch('metadata').fetch('name') == 'greenguard-clickhouse'
      abort 'ClickHouse Application source drift' unless source.fetch('path') == 'infra/gitops/disposable/clickhouse-chart'
      abort 'ClickHouse must precede its Kafka consumer' unless app.fetch('metadata').fetch('annotations').fetch('argocd.argoproj.io/sync-wave') == '28'
      clickhouse_values = source.dig('helm', 'valuesObject')
      abort 'ClickHouse values must preserve immutable image, persistent storage, and scoped credentials' unless
        clickhouse_values == values.fetch('clickhousePlane').reject { |key, _| key == 'enabled' }
    elsif %w[greenguard-pgbouncer greenguard-kafka-topics greenguard-schema-registry greenguard-kafka-connect greenguard-connector-registration greenguard-opensearch greenguard-cassandra].include?(app.fetch('metadata').fetch('name'))
      expected_planes = {
        'greenguard-pgbouncer' => ['infra/gitops/disposable/pgbouncer-chart', '22'],
        'greenguard-kafka-topics' => ['infra/gitops/disposable/streaming-topics-chart', '12'],
        'greenguard-schema-registry' => ['infra/kubernetes/disposable-data/registry', '13'],
        'greenguard-kafka-connect' => ['infra/gitops/disposable/kafka-connect-chart', '23'],
        'greenguard-connector-registration' => ['infra/gitops/disposable/connector-registration', '24'],
        'greenguard-opensearch' => ['infra/helm/greenguard-opensearch', '24'],
        'greenguard-cassandra' => ['infra/gitops/disposable/cassandra-chart', '24']
      }
      expected_path, expected_wave = expected_planes.fetch(app.fetch('metadata').fetch('name'))
      abort 'acceptance dependency source/order drift' unless source.fetch('path') == expected_path && app.fetch('metadata').fetch('annotations').fetch('argocd.argoproj.io/sync-wave') == expected_wave
      if source.key?('helm')
        object = source.fetch('helm').fetch('valuesObject')
        abort 'acceptance dependency image drift' unless (object['image'] || object['cassandraImage']) == digest
      end
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
  missing_shard_mode = JSON.parse(JSON.generate(values))
  broken_release = missing_shard_mode.fetch('releases').find { |release| release.fetch('name') == 'device-service' }
  broken_release.fetch('extraValues').fetch('container')['env'] = []
  file.rewind
  file.truncate(0)
  file.write(missing_shard_mode.to_yaml)
  file.flush
  _, missing_mode_error, missing_mode_status = Open3.capture3('helm', 'template', 'applications', chart, '--namespace', 'argocd', '-f', file.path)
  abort 'sharded release rendered without mandatory shard routing mode' if missing_mode_status.success?
  abort 'missing shard routing mode did not fail for the expected reason' unless missing_mode_error.include?('SHARD_ROUTING_REQUIRED=true')
  file.rewind
  file.truncate(0)
  file.write(values.to_yaml)
  file.flush
  root_rendered, root_error, root_status = Open3.capture3('helm', 'template', 'bootstrap', File.join(root, 'bootstrap-chart'), '--namespace', 'argocd', '-f', file.path)
  abort "bootstrap chart failed: #{root_error}" unless root_status.success?
  root_app = YAML.load_stream(root_rendered).compact.fetch(0)
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
    mesh_objects = YAML.load_stream(mesh_rendered).compact
    abort "#{chart_name} lacks STRICT PeerAuthentication" unless mesh_objects.any? { |item|
      item['kind'] == 'PeerAuthentication' && item.dig('spec', 'mtls', 'mode') == 'STRICT'
    }
    abort "#{chart_name} lacks injected Envoy sidecar" unless mesh_objects.any? { |item|
      item['kind'] == 'Deployment' && item.dig('spec', 'template', 'metadata', 'labels', 'sidecar.istio.io/inject') == 'true'
    }
  end
puts "Argo CD tree renders #{releases.length} digest-pinned runtime Applications plus data, observability, RDS bootstrap, 38-owner migration Jobs, and SQL migration gate Applications."
end
