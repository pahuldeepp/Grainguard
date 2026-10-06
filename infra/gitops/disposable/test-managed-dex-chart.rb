#!/usr/bin/env ruby
require 'yaml'
require 'open3'
require 'tempfile'

ROOT = __dir__
DIGEST = "ghcr.io/dexidp/dex:v2.41.1@sha256:#{'b' * 64}"
CLICKHOUSE_DIGEST = "example.test/clickhouse-client@sha256:#{'e' * 64}"
CONTROL_PLANE_DIGEST = "example.test/tenant-control-plane@sha256:#{'d' * 64}"
VALUES = {
  'cell' => 'gg-test',
  'repositoryUrl' => 'https://example.test/greenguard.git',
  'revision' => 'a' * 40,
  'observabilityImages' => %w[otel-collector prometheus grafana tempo loki].to_h { |name| [name, "example.test/#{name}@sha256:#{'c' * 64}"] },
  'edgeRouting' => {'enabled' => true, 'accountId' => '123456789012', 'region' => 'us-east-2', 'targetGroupARN' => 'arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/greenguard/0123456789abcdef'},
  'dataPlane' => {'enabled' => false},
  'searchPlane' => {'enabled' => false},
  'cassandraPlane' => {'enabled' => false},
  'mqttPlane' => {'enabled' => false},
  'clickhousePlane' => {'enabled' => false},
  'managedDex' => {
    'enabled' => true, 'image' => DIGEST,
    'issuer' => 'https://d111111abcdef8.cloudfront.net/dex',
    'webOrigin' => 'https://d222222abcdef8.cloudfront.net',
    'databaseHost' => 'db.example.us-east-2.rds.amazonaws.com',
    'databaseCIDRs' => ['10.0.1.0/24', '10.0.2.0/24'],
    'secret' => 'greenguard-dex-config', 'caSecret' => 'greenguard-rds-ca'
  },
  'acceptanceProbes' => {
    'enabled' => true,
    'clickhouseImage' => CLICKHOUSE_DIGEST,
    'tenantControlPlaneImage' => CONTROL_PLANE_DIGEST,
    'membershipAudience' => 'greenguard-dashboard'
  }
}.freeze

render = lambda do |chart, values|
  Tempfile.create(['managed-dex-', '.yaml']) do |f|
    f.write(values.to_yaml); f.flush
    out, err, status = Open3.capture3('helm', 'template', 'dex-test', File.join(ROOT, chart), '--namespace', 'argocd', '-f', f.path)
    [out, err, status]
  end
end
out, err, status = render.call('applications-chart', VALUES)
abort "Argo managed-Dex render failed: #{err}" unless status.success?
apps = YAML.load_stream(out).compact
app = apps.find { |item| item.dig('metadata', 'name') == 'greenguard-managed-dex' }
abort 'Managed Dex Argo Application missing' unless app
abort 'Managed Dex application identity/revision/values drifted' unless
  app.dig('metadata', 'labels', 'greenguard.io/cell') == 'gg-test' &&
  app.dig('metadata', 'finalizers') == ['resources-finalizer.argocd.argoproj.io'] &&
  app.dig('spec', 'source', 'targetRevision') == 'a' * 40 &&
  app.dig('spec', 'source', 'path') == 'infra/gitops/disposable/dex-chart' &&
  app.dig('spec', 'source', 'helm', 'valuesObject', 'issuer') == VALUES.dig('managedDex', 'issuer') &&
  app.dig('spec', 'source', 'helm', 'valuesObject', 'image') == DIGEST
edge = apps.find { |item| item.dig('metadata', 'name') == 'greenguard-edge-routing' }
abort 'Edge application failed to enable the Dex route' unless edge && edge.dig('spec', 'source', 'helm', 'valuesObject', 'dexEnabled') == true
rds = apps.find { |item| item.dig('metadata', 'name') == 'greenguard-rds-bootstrap' }
abort 'Central RDS bootstrap did not enable the marked Dex database owner' unless
  rds && rds.dig('spec', 'source', 'helm', 'valuesObject', 'managedDex') == true
acceptance = apps.find { |item| item.dig('metadata', 'name') == 'greenguard-live-acceptance-probes' }
abort 'Live acceptance probe child app did not gate initial membership on a human login' unless
  acceptance &&
  acceptance.dig('metadata', 'annotations', 'argocd.argoproj.io/sync-wave') == '29' &&
  acceptance.dig('spec', 'source', 'path') == 'infra/gitops/disposable/acceptance-probes-chart' &&
  acceptance.dig('spec', 'source', 'helm', 'valuesObject', 'clickhouseEnabled') == true &&
  acceptance.dig('spec', 'source', 'helm', 'valuesObject', 'membershipEnabled') == false &&
  acceptance.dig('spec', 'source', 'helm', 'valuesObject', 'clickhouseImage') == CLICKHOUSE_DIGEST &&
  acceptance.dig('spec', 'source', 'helm', 'valuesObject', 'tenantControlPlaneImage') == CONTROL_PLANE_DIGEST &&
  acceptance.dig('spec', 'source', 'helm', 'valuesObject', 'membershipAudience') == 'greenguard-dashboard' &&
  acceptance.dig('spec', 'source', 'helm', 'valuesObject', 'accessTokenSecret') == 'greenguard-acceptance-oidc-token'
rds_values = {
  'image' => 'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea',
  'credentialSecret' => 'greenguard-rds-bootstrap', 'caSecret' => 'greenguard-rds-ca',
  'name' => 'greenguard-rds-bootstrap', 'operationalOnly' => false,
  'managedDex' => true, 'rdsHost' => 'db.example.us-east-2.rds.amazonaws.com'
}
out, err, status = render.call('rds-bootstrap-chart', rds_values)
abort "Managed Dex RDS bootstrap render failed: #{err}" unless status.success?
rds_objects = YAML.load_stream(out).compact
rds_job = rds_objects.find { |item| item['kind'] == 'Job' }
abort 'Managed Dex central database initialization flag missing' unless
  rds_job.dig('spec', 'template', 'spec', 'containers', 0, 'args').include?('GG_MANAGED_DEX=1')
rds_values_without_dex = rds_values.merge('managedDex' => false)
out, err, status = render.call('rds-bootstrap-chart', rds_values_without_dex)
abort "Non-Dex RDS bootstrap regression render failed: #{err}" unless status.success?
plain_config = YAML.load_stream(out).compact.find { |item| item['kind'] == 'ConfigMap' }
abort 'RDS bootstrap revision does not change when the Dex database toggle changes' if
  plain_config.dig('metadata', 'name') == rds_objects.find { |item| item['kind'] == 'ConfigMap' }.dig('metadata', 'name')

edge_values = {'cell' => 'gg-test', 'accountId' => '123456789012', 'region' => 'us-east-2', 'targetGroupARN' => VALUES.dig('edgeRouting', 'targetGroupARN'), 'dexEnabled' => true}
out, err, status = render.call('edge-routing-chart', edge_values)
abort "Dex edge route render failed: #{err}" unless status.success?
virtual_service = YAML.load_stream(out).compact.find { |item| item['kind'] == 'VirtualService' }
route_names = virtual_service.dig('spec', 'http').map { |route| route['name'] }
abort 'Dex route is not ahead of the general BFF path' unless route_names.index('managed-dex') < route_names.index('bff')
disabled_route_values = edge_values.merge('dexEnabled' => false)
out, err, status = render.call('edge-routing-chart', disabled_route_values)
abort "Disabled Dex edge route render failed: #{err}" unless status.success?
disabled_vs = YAML.load_stream(out).compact.find { |item| item['kind'] == 'VirtualService' }
abort 'Dex route remains exposed when managed Dex is disabled' if disabled_vs.dig('spec', 'http').any? { |route| route['name'] == 'managed-dex' }

out, err, status = render.call('dex-chart', VALUES.fetch('managedDex').merge('cell' => VALUES.fetch('cell')))
abort "Dex workload chart render failed: #{err}" unless status.success?
objects = YAML.load_stream(out).compact
workload = objects.find { |item| item.dig('kind') == 'Deployment' }
config = objects.find { |item| item.dig('kind') == 'ConfigMap' }
abort 'Dex deployment is not digest-pinned / secret-backed' unless
  workload.dig('spec', 'template', 'spec', 'containers', 0, 'image') == DIGEST &&
  workload.dig('spec', 'template', 'spec', 'containers', 0, 'envFrom', 0, 'secretRef', 'name') == 'greenguard-dex-config'
abort 'Dex environment expansion is not explicitly enabled for secret-backed config' unless
  workload.dig('spec', 'template', 'spec', 'containers', 0, 'env').include?({'name' => 'DEX_EXPAND_ENV', 'value' => 'true'})
abort 'Dex config lost HTTPS issuer, TLS Postgres, PKCE, or fixed public clients' unless
  config.dig('data', 'config.yaml').include?('issuer: ${DEX_ISSUER}') &&
  config.dig('data', 'config.yaml').include?('mode: verify-full') &&
  config.dig('data', 'config.yaml').include?('enforce: true') &&
  config.dig('data', 'config.yaml').include?('greenguard://auth/callback')
parsed_config = YAML.safe_load(config.dig('data', 'config.yaml'), aliases: false)
abort 'Dex public PKCE client registration drifted' unless
  parsed_config.dig('oauth2', 'pkce', 'enforce') == true &&
  parsed_config.dig('staticClients').map { |client| client['id'] } == ['${DEX_DASHBOARD_CLIENT_ID}', '${DEX_MOBILE_CLIENT_ID}'] &&
  parsed_config.dig('storage', 'config', 'ssl', 'caFile') == '/etc/greenguard/rds/ca.pem' &&
  parsed_config.dig('staticPasswords').one? &&
  parsed_config.dig('staticPasswords', 0, 'hash') == '${DEX_FIRST_ADMIN_PASSWORD_HASH}' &&
  parsed_config.dig('staticPasswords', 0, 'userID') == '${DEX_FIRST_ADMIN_USER_ID}'
# The configured UUID is Dex's internal local-connector user ID. The token's
# `sub` is connector-qualified and must be read from a verified issued token;
# it must never be treated as this UUID when establishing tenant membership.
abort 'Dex internal user ID was incorrectly configured or named as token sub' if
  config.dig('data', 'config.yaml').match?(/(?:MEMBERSHIP_SUBJECT|TOKEN_SUB)\s*[:=].*DEX_FIRST_ADMIN_USER_ID/)
abort 'Dex fixture users leaked into managed configuration' if config.dig('data', 'config.yaml').match?(/alice@greenguard\.test|victor@greenguard\.test|bob@greenguard\.test/)

network_policy = objects.find { |item| item['kind'] == 'NetworkPolicy' }
ingress_source = network_policy.dig('spec', 'ingress', 0, 'from', 0)
abort 'Dex ingress is not restricted to the Istio ingress gateway' unless
  ingress_source.dig('namespaceSelector', 'matchLabels', 'kubernetes.io/metadata.name') == 'istio-system' &&
  ingress_source.dig('podSelector', 'matchLabels', 'app') == 'istio-ingressgateway'
abort 'Dex sidecar cannot reach Istiod for xDS/certificate issuance' unless
  network_policy.dig('spec', 'egress').any? do |rule|
    rule.dig('to', 0, 'namespaceSelector', 'matchLabels', 'kubernetes.io/metadata.name') == 'istio-system' &&
      rule.dig('to', 0, 'podSelector', 'matchLabels', 'app') == 'istiod' &&
      rule.dig('ports')&.any? { |port| port['port'] == 15012 }
  end

invalid = VALUES.fetch('managedDex').merge('cell' => VALUES.fetch('cell'), 'image' => 'ghcr.io/dexidp/dex:latest')
_, _, status = render.call('dex-chart', invalid)
abort 'Mutable Dex image tag was accepted' if status.success?
puts 'Managed Dex: HTTPS CloudFront issuer, immutable image, Postgres verify-full storage, PKCE, separate external admin credential input, conditional edge/Argo wiring, and no local fixture users verified.'
