#!/usr/bin/env ruby
require 'yaml'
require 'open3'
require 'tempfile'

root = __dir__
digest = "example.test/greenguard/data@sha256:#{'a' * 64}"
values = {
  'cell' => 'greenguard-test',
  'repositoryUrl' => 'https://example.test/greenguard.git',
  'revision' => 'b' * 40,
  'observabilityImages' => %w[otel-collector prometheus grafana tempo loki].to_h { |name| [name, digest] },
  'cassandraPlane' => {'enabled' => true, 'image' => digest, 'migratorImage' => digest, 'authSecret' => 'greenguard-cassandra-auth', 'tlsSecret' => 'greenguard-cassandra-tls', 'apiServerCIDR' => '10.100.0.1/32', 'storageClassName' => 'gp3', 'storageSize' => '20Gi'},
  'dataPlane' => {
    'enabled' => true,
    'rdsHost' => 'db.example.us-east-1.rds.amazonaws.com',
    'images' => %w[pgbouncer kafka-topics kafka-connect connector-registration].to_h { |name| [name, digest] },
    'shards' => {
      's1' => {'rdsHost' => 'shard1.example.us-east-1.rds.amazonaws.com', 'cdcSecret' => 'greenguard-shard1-cdc', 'bootstrapSecret' => 'greenguard-s1-rds-bootstrap', 'tenantBootstrapSecret' => 'greenguard-s1-tenant-bootstrap', 'tenantBootstrapVersion' => 'v1', 'tenantBootstrapRole' => 'tenant_bootstrap_s1', 'pgbouncerAuthSecret' => 'greenguard-s1-pgbouncer-auth', 'projectionMaintenanceSecret' => 'greenguard-s1-projection-history-maintenance-config'},
      's2' => {'rdsHost' => 'shard2.example.us-east-1.rds.amazonaws.com', 'cdcSecret' => 'greenguard-shard2-cdc', 'bootstrapSecret' => 'greenguard-s2-rds-bootstrap', 'tenantBootstrapSecret' => 'greenguard-s2-tenant-bootstrap', 'tenantBootstrapVersion' => 'v1', 'tenantBootstrapRole' => 'tenant_bootstrap_s2', 'pgbouncerAuthSecret' => 'greenguard-s2-pgbouncer-auth', 'projectionMaintenanceSecret' => 'greenguard-s2-projection-history-maintenance-config'},
      's3' => {'rdsHost' => 'shard3.example.us-east-1.rds.amazonaws.com', 'cdcSecret' => 'greenguard-shard3-cdc', 'bootstrapSecret' => 'greenguard-s3-rds-bootstrap', 'tenantBootstrapSecret' => 'greenguard-s3-tenant-bootstrap', 'tenantBootstrapVersion' => 'v1', 'tenantBootstrapRole' => 'tenant_bootstrap_s3', 'pgbouncerAuthSecret' => 'greenguard-s3-pgbouncer-auth', 'projectionMaintenanceSecret' => 'greenguard-s3-projection-history-maintenance-config'},
      's4' => {'rdsHost' => 'shard4.example.us-east-1.rds.amazonaws.com', 'cdcSecret' => 'greenguard-shard4-cdc', 'bootstrapSecret' => 'greenguard-s4-rds-bootstrap', 'tenantBootstrapSecret' => 'greenguard-s4-tenant-bootstrap', 'tenantBootstrapVersion' => 'v1', 'tenantBootstrapRole' => 'tenant_bootstrap_s4', 'pgbouncerAuthSecret' => 'greenguard-s4-pgbouncer-auth', 'projectionMaintenanceSecret' => 'greenguard-s4-projection-history-maintenance-config'}
    },
    'projectionMaintenance' => {'image' => digest, 'rdsCIDRs' => ['10.60.128.0/20']},
    'secrets' => {
      'pgbouncerAuth' => 'greenguard-pgbouncer-auth',
      'rdsCa' => 'greenguard-rds-ca',
      'cdcCredentials' => 'greenguard-cdc-credentials'
    }
  },
  'mqttPlane' => {'enabled' => true, 'image' => digest, 'credentialSecret' => 'greenguard-mqtt-broker'}
}

render = lambda do |chart, fixture|
  Tempfile.create(['data-plane-', '.yaml']) do |file|
    file.write(fixture.to_yaml)
    file.flush
    Open3.capture3('helm', 'template', 'data-plane', File.join(root, chart), '--namespace', 'argocd', '-f', file.path)
  end
end

output, error, status = render.call('applications-chart', values)
abort "data plane Argo render failed: #{error}" unless status.success?
apps = YAML.load_stream(output).compact
mqtt = apps.find { |item| item.dig('metadata', 'name') == 'greenguard-mqtt' }
abort 'private MQTT Application missing or ordered after worker' unless mqtt &&
  mqtt.dig('metadata', 'annotations', 'argocd.argoproj.io/sync-wave') == '11' &&
  mqtt.dig('spec', 'source', 'path') == 'infra/gitops/disposable/mqtt-chart' &&
  mqtt.dig('spec', 'source', 'helm', 'valuesObject') == {'image' => digest, 'credentialSecret' => 'greenguard-mqtt-broker'} &&
  mqtt.dig('spec', 'destination', 'namespace') == 'greenguard' &&
  mqtt.dig('metadata', 'finalizers') == ['resources-finalizer.argocd.argoproj.io']
registry = apps.find { |item| item.dig('metadata', 'name') == 'greenguard-schema-registry' }
abort 'Registry must follow ACL/topic bootstrap in wave 13' unless registry &&
  registry.dig('metadata', 'annotations', 'argocd.argoproj.io/sync-wave') == '13' &&
  registry.dig('spec', 'source', 'path') == 'infra/kubernetes/disposable-data/registry' &&
  registry.dig('metadata', 'finalizers') == ['resources-finalizer.argocd.argoproj.io']
expected = {
  'greenguard-kafka-topics' => ['12', 'streaming-topics-chart'],
  'greenguard-pgbouncer' => ['22', 'pgbouncer-chart'],
  'greenguard-kafka-connect' => ['23', 'kafka-connect-chart'],
  'greenguard-connector-registration' => ['24', 'connector-registration']
}
expected.each do |name, (wave, chart)|
  app = apps.find { |item| item.dig('metadata', 'name') == name }
  abort "#{name} Application missing" unless app
  abort "#{name} ordering/source wrong" unless app.dig('metadata', 'annotations', 'argocd.argoproj.io/sync-wave') == wave &&
    app.dig('spec', 'source', 'path') == "infra/gitops/disposable/#{chart}" &&
    app.dig('spec', 'source', 'targetRevision') == values['revision']
  abort "#{name} lifecycle ownership missing" unless app.dig('metadata', 'finalizers') == ['resources-finalizer.argocd.argoproj.io']
end
%w[s1 s2 s3 s4].each do |shard|
  shard_bootstrap = apps.find { |item| item.dig('metadata', 'name') == "greenguard-#{shard}-rds-bootstrap" }
  shard_values = shard_bootstrap&.dig('spec', 'source', 'helm', 'valuesObject')
  expected_shard = values.dig('dataPlane', 'shards', shard)
  abort "#{shard} tenant-bootstrap Secret/role/version drifted" unless shard_values &&
    shard_values['tenantBootstrapSecret'] == expected_shard['tenantBootstrapSecret'] &&
    shard_values['tenantBootstrapRole'] == expected_shard['tenantBootstrapRole'] &&
    shard_values['tenantBootstrapVersion'] == expected_shard['tenantBootstrapVersion']
end
abort 'PgBouncer source values drifted' unless apps.find { |item| item.dig('metadata', 'name') == 'greenguard-pgbouncer' }
  .dig('spec', 'source', 'helm', 'valuesObject') == {
    'image' => digest, 'rdsHost' => values.dig('dataPlane', 'rdsHost'),
    'authSecret' => 'greenguard-pgbouncer-auth', 'caSecret' => 'greenguard-rds-ca'
  }
abort 'Connect source Secret drifted' unless apps.find { |item| item.dig('metadata', 'name') == 'greenguard-kafka-connect' }
  .dig('spec', 'source', 'helm', 'valuesObject', 'credentialSecret') == 'greenguard-cdc-credentials'
connect_values = apps.find { |item| item.dig('metadata', 'name') == 'greenguard-kafka-connect' }
  .dig('spec', 'source', 'helm', 'valuesObject')
abort 'Connect shard credentials were not attached by Application name' unless connect_values['shardCredentials'] == {
  's1' => 'greenguard-shard1-cdc', 's2' => 'greenguard-shard2-cdc',
  's3' => 'greenguard-shard3-cdc', 's4' => 'greenguard-shard4-cdc'
}
registration_values = apps.find { |item| item.dig('metadata', 'name') == 'greenguard-connector-registration' }
  .dig('spec', 'source', 'helm', 'valuesObject')
abort 'Connector registration shard hosts were not attached by Application name' unless registration_values['shards'] == {
  's1' => 'shard1.example.us-east-1.rds.amazonaws.com', 's2' => 'shard2.example.us-east-1.rds.amazonaws.com',
  's3' => 'shard3.example.us-east-1.rds.amazonaws.com', 's4' => 'shard4.example.us-east-1.rds.amazonaws.com'
}

root_output, root_error, root_status = render.call('bootstrap-chart', values)
abort "root data-plane render failed: #{root_error}" unless root_status.success?
root_app = YAML.load_stream(root_output).compact.fetch(0)
abort 'root lost data-plane values' unless root_app.dig('spec', 'source', 'helm', 'valuesObject', 'dataPlane') == values.fetch('dataPlane')
abort 'root lost MQTT values' unless root_app.dig('spec', 'source', 'helm', 'valuesObject', 'mqttPlane') == values.fetch('mqttPlane')

bad = Marshal.load(Marshal.dump(values))
bad['mqttPlane']['image'] = 'mosquitto:latest'
_, _, invalid = render.call('applications-chart', bad)
abort 'mutable MQTT image accepted' if invalid.success?
_, _, invalid_root = render.call('bootstrap-chart', bad)
abort 'root accepted mutable MQTT image' if invalid_root.success?
bad = Marshal.load(Marshal.dump(values))
bad['mqttPlane']['credentialSecret'] = 'wrong-secret'
_, _, invalid = render.call('applications-chart', bad)
abort 'incorrect MQTT credential Secret accepted' if invalid.success?
_, _, invalid_root = render.call('bootstrap-chart', bad)
abort 'root accepted incorrect MQTT credential Secret' if invalid_root.success?

bad = Marshal.load(Marshal.dump(values))
bad['dataPlane']['images']['kafka-connect'] = 'mutable:latest'
_, _, invalid = render.call('applications-chart', bad)
abort 'mutable Connect image accepted' if invalid.success?
_, _, invalid_root = render.call('bootstrap-chart', bad)
abort 'root accepted mutable Connect image' if invalid_root.success?
bad = Marshal.load(Marshal.dump(values))
bad['dataPlane']['secrets'].delete('cdcCredentials')
_, _, invalid = render.call('applications-chart', bad)
abort 'missing CDC Secret accepted' if invalid.success?
_, _, invalid_root = render.call('bootstrap-chart', bad)
abort 'root accepted missing CDC Secret' if invalid_root.success?
bad = Marshal.load(Marshal.dump(values))
bad['dataPlane']['rdsHost'] = 'attacker.example.test'
_, _, invalid = render.call('applications-chart', bad)
abort 'non-RDS host accepted' if invalid.success?
_, _, invalid_root = render.call('bootstrap-chart', bad)
abort 'root accepted non-RDS host' if invalid_root.success?
bad = Marshal.load(Marshal.dump(values))
bad['dataPlane']['enabled'] = 'false'
_, _, invalid = render.call('applications-chart', bad)
abort 'string false enabled data plane accepted' if invalid.success?
_, _, invalid_root = render.call('bootstrap-chart', bad)
abort 'root accepted string false enabled data plane' if invalid_root.success?
bad = Marshal.load(Marshal.dump(values))
bad['dataPlane']['enabled'] = false
disabled_output, disabled_error, disabled_status = render.call('applications-chart', bad)
abort "disabled data-plane render failed: #{disabled_error}" unless disabled_status.success?
abort 'Registry must not start without ACL/topic child' if YAML.load_stream(disabled_output).compact.any? { |item| item.dig('metadata', 'name') == 'greenguard-schema-registry' }
disabled_apps = YAML.load_stream(disabled_output).compact
abort 'data-plane child rendered while disabled' if disabled_apps.any? { |item| expected.key?(item.dig('metadata', 'name')) }

puts 'Data-plane Argo children, ordering, pinned values, and reject fixtures pass.'
