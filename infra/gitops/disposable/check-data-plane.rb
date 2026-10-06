#!/usr/bin/env ruby
require 'yaml'
require 'open3'
require 'set'

root = __dir__
terraform = File.read(File.join(root, '../../terraform/disposable/gitops.tf'))
abort 'Terraform lost data-plane image inputs or RDS host wiring' unless
  terraform.include?('variable "data_plane_image_digests"') &&
  terraform.include?('dataPlane = {') &&
  terraform.include?('rdsHost = aws_db_instance.postgres.address') &&
  terraform.include?('images  = var.data_plane_image_digests') &&
  terraform.include?('local.required_data_plane_secrets')
render = lambda do |chart, values|
  path = File.join(root, chart)
  flags = values.flat_map { |key, value| ['--set-string', "#{key}=#{value}"] }
  output, error, status = Open3.capture3('helm', 'template', chart, path, '--namespace', 'greenguard', *flags)
  abort "#{chart} render failed: #{error}" unless status.success?
  YAML.load_stream(output).compact
end

digest = "example.test/disposable@sha256:#{'a' * 64}"
%w[pgbouncer-chart kafka-connect-chart].each do |chart|
  _, _, status = Open3.capture3('helm', 'template', chart, File.join(root, chart))
  abort "#{chart} accepted missing image digest" if status.success?
end
_, _, status = Open3.capture3('helm', 'template', 'pgbouncer', File.join(root, 'pgbouncer-chart'), '--set-string', "image=#{digest}")
abort 'PgBouncer accepted missing RDS host' if status.success?
_, _, status = Open3.capture3('helm', 'template', 'pgbouncer', File.join(root, 'pgbouncer-chart'), '--set-string', "image=#{digest}", '--set-string', 'rdsHost=attacker.example.test')
abort 'PgBouncer accepted a non-RDS host' if status.success?
_, _, status = Open3.capture3('helm', 'template', 'connect', File.join(root, 'kafka-connect-chart'), '--set-string', "image=#{digest}", '--set-string', 'credentialSecret=')
abort 'Connect accepted an empty credential Secret' if status.success?
_, _, status = Open3.capture3('helm', 'template', 'connect', File.join(root, 'kafka-connect-chart'), '--set-string', "image=#{digest}", '--set-string', 'caSecret=')
abort 'Connect accepted an empty RDS CA Secret' if status.success?
%w[kafkaCaSecret kafkaCredentialSecret].each do |key|
  _, _, status = Open3.capture3('helm', 'template', 'connect', File.join(root, 'kafka-connect-chart'), '--set-string', "image=#{digest}", '--set-string', "#{key}=")
  abort "Connect accepted an empty #{key}" if status.success?
end

pg = render.call('pgbouncer-chart', { 'image' => digest, 'rdsHost' => 'db.example.us-east-1.rds.amazonaws.com' })
config = pg.find { |item| item['kind'] == 'ConfigMap' }.dig('data', 'pgbouncer.ini')
abort 'PgBouncer RDS upstream TLS missing' unless config.include?('server_tls_sslmode = verify-full') && config.include?('server_tls_ca_file = /rds-ca/ca.pem')
abort 'PgBouncer transaction pooling missing' unless config.include?('pool_mode = transaction') && config.scan(/= host=db\.example\.us-east-1\.rds\.amazonaws\.com port=5432/).length == 11
pg_deploy = pg.find { |item| item['kind'] == 'Deployment' }
pg_pod = pg_deploy.dig('spec', 'template', 'spec')
abort 'PgBouncer Secret refs missing' unless %w[greenguard-pgbouncer-auth greenguard-rds-ca].all? { |secret| pg_pod.fetch('volumes').any? { |v| v.dig('secret', 'secretName') == secret } }
abort 'PgBouncer not private/non-root' unless pg.find { |item| item['kind'] == 'Service' }.dig('spec', 'type') == 'ClusterIP' && pg_pod.dig('securityContext', 'runAsUser') == 10001 && pg_pod['automountServiceAccountToken'] == false

topic_source, topic_error, topic_status = Open3.capture3('ruby', File.join(root, 'streaming-topics-chart/generate-topics.rb'))
abort "topic generator failed: #{topic_error}" unless topic_status.success?
topic_copy = File.read(File.join(root, 'streaming-topics-chart/files/topics.tsv'))
abort 'Kafka topic inventory drifted from local lifecycle source' unless topic_copy == topic_source
abort 'expected 43 Kafka topics' unless topic_copy.lines.length == 43
topics = render.call('streaming-topics-chart', {})
topic_job = topics.find { |item| item['kind'] == 'Job' && item.dig('metadata', 'name')&.start_with?('greenguard-topics-') }
abort 'Kafka topic Job must be bounded/non-root' unless topic_job.dig('spec', 'activeDeadlineSeconds').to_i.positive? && topic_job.dig('spec', 'template', 'spec', 'securityContext', 'runAsNonRoot') == true
abort 'Kafka topic Job must use pinned broker image' unless topic_job.dig('spec', 'template', 'spec', 'containers', 0, 'image').match?(/@sha256:[a-f0-9]{64}\z/)
topic_pod = topic_job.dig('spec', 'template', 'spec')
topic_container = topic_pod.fetch('containers').first
topic_script = topic_container.fetch('args').first
abort 'Kafka topic Job must use scoped admin JAAS and CA' unless
  topic_container.fetch('env').any? { |item| item['name'] == 'KAFKA_SASL_JAAS_CONFIG' && item.dig('valueFrom', 'secretKeyRef') == { 'name' => 'greenguard-kafka-admin-auth', 'key' => 'KAFKA_SASL_JAAS_CONFIG' } } &&
  topic_pod.fetch('volumes').any? { |item| item.dig('secret', 'secretName') == 'greenguard-kafka-ca' && item.dig('secret', 'items')&.any? { |entry| entry['key'] == 'ca.crt' } } &&
  topic_script.include?('security.protocol=SASL_SSL') && topic_script.include?('sasl.mechanism=PLAIN') &&
  topic_script.scan('--command-config /tmp/kafka-client.properties').length == 3
abort 'Kafka topic ConfigMap missing' unless topics.find { |item| item['kind'] == 'ConfigMap' && item.dig('metadata', 'name')&.start_with?('greenguard-topics-') }.dig('data', 'topics.tsv') == topic_copy
acl_copy = File.read(File.join(root, 'streaming-topics-chart/files/acls.tsv'))
acl_docs = topics.select { |item| item.dig('metadata', 'name')&.start_with?('greenguard-acls-') }
acl_job = acl_docs.find { |item| item['kind'] == 'Job' }
acl_config = acl_docs.find { |item| item['kind'] == 'ConfigMap' }
abort 'Kafka ACL bootstrap Job/inventory missing' unless acl_job && acl_config.dig('data', 'acls.tsv') == acl_copy
acl_pod = acl_job.dig('spec', 'template', 'spec')
acl_container = acl_pod.fetch('containers').first
abort 'Kafka ACL Job must be bounded, non-root and use the admin Secret/CA' unless
  acl_job.dig('spec', 'activeDeadlineSeconds').to_i.positive? &&
  acl_pod.dig('securityContext', 'runAsNonRoot') == true &&
  acl_container.fetch('env').any? { |item| item['name'] == 'KAFKA_SASL_JAAS_CONFIG' && item.dig('valueFrom', 'secretKeyRef') == { 'name' => 'greenguard-kafka-admin-auth', 'key' => 'KAFKA_SASL_JAAS_CONFIG' } } &&
  acl_pod.fetch('volumes').any? { |item| item.dig('secret', 'secretName') == 'greenguard-kafka-ca' } &&
  acl_container.fetch('args').first.include?('--command-config /tmp/kafka-client.properties')
known_topics = topic_copy.lines.map { |line| line.split('|', 2).first }.to_set
known_principals = %w[registry connect cdc-transformer projection-builder cache-invalidator risk-engine hardware-service-worker eventbridge-bridge saga-api saga-worker billing-service notification-service cassandra-writer search-indexer read-api workflow-alerts device-service telemetry-ingest jobs-worker tenant-control-plane telemetry-sinks telemetry-replay knowledge-service model-gateway-usage]
acl_principals = []
acl_copy.lines.each do |line|
  next if line.start_with?('#') || line.strip.empty?
  principal, kind, pattern, names, operations = line.strip.split('|', 5)
  abort 'Kafka ACL row malformed or grants an unknown principal' unless known_principals.include?(principal) && %w[topic group cluster].include?(kind) && %w[literal prefixed].include?(pattern) && names && operations
  abort 'Kafka ACL has broad or unknown topic pattern' if kind == 'topic' && (pattern != 'literal' || names.split(',').any? { |name| !known_topics.include?(name) })
  abort 'Kafka ACL group/cluster scope invalid' if kind == 'group' && names.split(',').any? { |name| name !~ /\A[a-zA-Z0-9._-]+\z/ }
  abort 'Kafka ACL cluster scope invalid' if kind == 'cluster' && (pattern != 'literal' || names != 'kafka-cluster')
  abort 'Kafka ACL grants unsupported operation' if operations.split(',').any? { |op| !%w[Read Write Describe IdempotentWrite].include?(op) }
  acl_principals << principal
end
abort 'Kafka ACL inventory omits an active principal' unless (known_principals - acl_principals).empty?

connect = render.call('kafka-connect-chart', { 'image' => digest })
connect_service = connect.find { |item| item['kind'] == 'Service' }
connect_policy = connect.find { |item| item['kind'] == 'NetworkPolicy' }
connect_pod = connect.find { |item| item['kind'] == 'Deployment' }.dig('spec', 'template', 'spec')
connect_container = connect_pod.fetch('containers').fetch(0)
abort 'Connect must be private and non-root' unless connect_service.dig('spec', 'type') == 'ClusterIP' && connect_pod.dig('securityContext', 'runAsUser') == 1001 && connect_pod['automountServiceAccountToken'] == false
abort 'Connect REST must admit only registration Jobs' unless connect_policy.dig('spec', 'podSelector', 'matchLabels') == { 'app' => 'connect' } && connect_policy.dig('spec', 'ingress') == [{ 'from' => [{ 'podSelector' => { 'matchLabels' => { 'app' => 'connector-registration' } } }], 'ports' => [{ 'protocol' => 'TCP', 'port' => 8083 }] }]
abort 'Connect CDC password Secret ref missing' unless connect_container.fetch('env').any? { |item| item['name'] == 'CDC_DB_PASSWORD' && item.dig('valueFrom', 'secretKeyRef', 'key') == 'CDC_DB_PASSWORD' }
abort 'Connect RDS CA mount missing' unless connect_pod.fetch('volumes').any? { |item| item.dig('secret', 'secretName') == 'greenguard-rds-ca' && item.dig('secret', 'items')&.any? { |entry| entry['key'] == 'ca.pem' && entry['path'] == 'ca.pem' } } && connect_container.fetch('volumeMounts').any? { |item| item['name'] == 'rds-ca' && item['mountPath'] == '/rds-ca' && item['readOnly'] == true }
abort 'Connect Kafka CA mount missing' unless connect_pod.fetch('volumes').any? { |item| item.dig('secret', 'secretName') == 'greenguard-kafka-ca' && item.dig('secret', 'items')&.any? { |entry| entry['key'] == 'ca.crt' && entry['path'] == 'ca.crt' } } && connect_container.fetch('volumeMounts').any? { |item| item['name'] == 'kafka-ca' && item['mountPath'] == '/etc/greenguard/kafka' && item['readOnly'] == true }
connect_env = connect_container.fetch('env').to_h { |item| [item.fetch('name'), item] }
abort 'Connect broker TLS/SASL contract missing' unless connect_env.dig('CONNECT_SECURITY_PROTOCOL', 'value') == 'SASL_SSL' && connect_env.dig('CONNECT_SASL_MECHANISM', 'value') == 'PLAIN' && connect_env.dig('CONNECT_SSL_TRUSTSTORE_TYPE', 'value') == 'PEM' && connect_env.dig('CONNECT_SSL_TRUSTSTORE_LOCATION', 'value') == '/etc/greenguard/kafka/ca.crt' && connect_env.dig('CONNECT_SSL_ENDPOINT_IDENTIFICATION_ALGORITHM', 'value') == 'HTTPS' && connect_env.dig('CONNECT_SASL_JAAS_CONFIG', 'valueFrom', 'secretKeyRef') == { 'name' => 'greenguard-kafka-connect-auth', 'key' => 'KAFKA_SASL_JAAS_CONFIG' }
abort 'Connect topic auto-create must stay disabled' unless connect_container.fetch('env').any? { |item| item['name'] == 'CONNECT_TOPIC_CREATION_ENABLE' && item['value'] == 'false' }
abort 'Connect probes/resources missing' unless %w[startupProbe readinessProbe livenessProbe resources].all? { |key| connect_container.key?(key) }

argo_output, argo_error, argo_status = Open3.capture3('ruby', File.join(root, 'test-data-plane-applications.rb'))
abort "data plane Argo check failed: #{argo_error}" unless argo_status.success?
puts 'Disposable PgBouncer, Kafka topic inventory, Connect charts, and Argo child ordering pass offline shape checks.'
if ARGV.include?('--ready')
  abort 'Data plane not ready: images and Secret values are undelivered; connector/schema registration, NetworkPolicy/mesh and live Kafka ACL/TLS/RDS proof are unverified.'
end
