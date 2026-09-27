#!/usr/bin/env ruby
require 'yaml'
require 'open3'

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
  YAML.safe_load_stream(output).compact
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
abort 'expected 39 Kafka topics' unless topic_copy.lines.length == 39
topics = render.call('streaming-topics-chart', {})
topic_job = topics.find { |item| item['kind'] == 'Job' }
abort 'Kafka topic Job must be bounded/non-root' unless topic_job.dig('spec', 'activeDeadlineSeconds').to_i.positive? && topic_job.dig('spec', 'template', 'spec', 'securityContext', 'runAsNonRoot') == true
abort 'Kafka topic Job must use pinned broker image' unless topic_job.dig('spec', 'template', 'spec', 'containers', 0, 'image').match?(/@sha256:[a-f0-9]{64}\z/)
abort 'Kafka topic ConfigMap missing' unless topics.find { |item| item['kind'] == 'ConfigMap' }.dig('data', 'topics.tsv') == topic_copy

connect = render.call('kafka-connect-chart', { 'image' => digest })
connect_service = connect.find { |item| item['kind'] == 'Service' }
connect_pod = connect.find { |item| item['kind'] == 'Deployment' }.dig('spec', 'template', 'spec')
connect_container = connect_pod.fetch('containers').fetch(0)
abort 'Connect must be private and non-root' unless connect_service.dig('spec', 'type') == 'ClusterIP' && connect_pod.dig('securityContext', 'runAsUser') == 1001 && connect_pod['automountServiceAccountToken'] == false
abort 'Connect CDC password Secret ref missing' unless connect_container.fetch('env').any? { |item| item['name'] == 'CDC_DB_PASSWORD' && item.dig('valueFrom', 'secretKeyRef', 'key') == 'CDC_DB_PASSWORD' }
abort 'Connect RDS CA mount missing' unless connect_pod.fetch('volumes').any? { |item| item.dig('secret', 'secretName') == 'greenguard-rds-ca' && item.dig('secret', 'items')&.any? { |entry| entry['key'] == 'ca.pem' && entry['path'] == 'ca.pem' } } && connect_container.fetch('volumeMounts').any? { |item| item['name'] == 'rds-ca' && item['mountPath'] == '/rds-ca' && item['readOnly'] == true }
abort 'Connect topic auto-create must stay disabled' unless connect_container.fetch('env').any? { |item| item['name'] == 'CONNECT_TOPIC_CREATION_ENABLE' && item['value'] == 'false' }
abort 'Connect probes/resources missing' unless %w[startupProbe readinessProbe livenessProbe resources].all? { |key| connect_container.key?(key) }

argo_output, argo_error, argo_status = Open3.capture3('ruby', File.join(root, 'test-data-plane-applications.rb'))
abort "data plane Argo check failed: #{argo_error}" unless argo_status.success?
puts 'Disposable PgBouncer, Kafka topic inventory, Connect charts, and Argo child ordering pass offline shape checks.'
if ARGV.include?('--ready')
  abort 'Data plane not ready: images are unpublished; Secret values and RDS host are not delivered; connector registration is unwired, and schema registration, Kafka credentials/ACL, NetworkPolicy/mesh and live Kafka/RDS proof are missing.'
end
