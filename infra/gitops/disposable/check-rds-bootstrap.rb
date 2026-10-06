#!/usr/bin/env ruby
require 'yaml'
require 'open3'
require 'digest'
require 'tempfile'

root = __dir__
source_sql = File.join(root, '../../compose/init-databases.sql')
chart_sql = File.join(root, 'rds-bootstrap-chart/files/init-databases.sql')
abort 'RDS bootstrap SQL drifted from Compose source' unless Digest::SHA256.file(source_sql).hexdigest == Digest::SHA256.file(chart_sql).hexdigest
sql = File.read(source_sql)
abort 'RDS replication role adaptation missing' unless sql.include?('GRANT rds_replication TO cdc_reader WITH INHERIT TRUE, SET FALSE;') && sql.include?('\\if :{?GG_RDS}')

rendered, error, status = Open3.capture3('helm', 'template', 'rds-bootstrap', File.join(root, 'rds-bootstrap-chart'), '--namespace', 'greenguard')
abort "RDS bootstrap chart render failed: #{error}" unless status.success?
objects = YAML.safe_load_stream(rendered).compact
abort 'expected one ConfigMap and one Job' unless objects.map { |object| object.fetch('kind') }.sort == %w[ConfigMap Job]
job = objects.find { |object| object.fetch('kind') == 'Job' }
container = job.dig('spec', 'template', 'spec', 'containers').fetch(0)
args = container.fetch('args')
abort 'RDS-safe branch not selected' unless args.each_cons(2).include?(%w[-v GG_RDS=1])
abort 'TLS verification missing' unless container.fetch('env').any? { |env| env['name'] == 'PGSSLMODE' && env['value'] == 'verify-full' }
abort 'credential secret missing' unless container.fetch('envFrom').fetch(0).dig('secretRef', 'name') == 'greenguard-rds-bootstrap'
abort 'RDS CA secret missing' unless job.dig('spec', 'template', 'spec', 'volumes').any? { |v| v.dig('secret', 'secretName') == 'greenguard-rds-ca' }
abort 'Job deadline missing' unless job.dig('spec', 'activeDeadlineSeconds').to_i.positive?
abort 'Job API token mounted' unless job.dig('spec', 'template', 'spec', 'automountServiceAccountToken') == false
abort 'central bootstrap accidentally renders a tenant login job' if objects.any? { |object| object.dig('metadata', 'name').to_s.include?('-login-') }

operational_values = {
  'operationalOnly' => true,
  'rdsHost' => 'shard1.example.us-east-1.rds.amazonaws.com',
  'name' => 'greenguard-s1-rds-bootstrap',
  'credentialSecret' => 'greenguard-s1-rds-bootstrap',
  'tenantBootstrapSecret' => 'greenguard-s1-tenant-bootstrap',
  'tenantBootstrapVersion' => 'version-rotation-2',
  'tenantBootstrapRole' => 'tenant_bootstrap_s1'
}
Tempfile.create(['rds-bootstrap-values-', '.yaml']) do |file|
  file.write(operational_values.to_yaml)
  file.flush
  shard_output, shard_error, shard_status = Open3.capture3('helm', 'template', 'rds-bootstrap', File.join(root, 'rds-bootstrap-chart'), '--namespace', 'greenguard', '-f', file.path)
  abort "operational RDS bootstrap chart render failed: #{shard_error}" unless shard_status.success?
  shard_objects = YAML.safe_load_stream(shard_output).compact
  login_job = shard_objects.find { |object| object.dig('metadata', 'name').include?('-login-') && object.fetch('kind') == 'Job' }
  abort 'operational shard login Job missing' unless login_job
  login_container = login_job.dig('spec', 'template', 'spec', 'containers').fetch(0)
  refs = login_container.fetch('env').to_h { |env| [env['name'], env['valueFrom']&.dig('secretKeyRef')] }
  abort 'login Job must read only the admin password and dedicated login password keys' unless refs['PGPASSWORD'] == {'name' => 'greenguard-s1-rds-bootstrap', 'key' => 'PGPASSWORD'} && refs['TENANT_BOOTSTRAP_PASSWORD'] == {'name' => 'greenguard-s1-tenant-bootstrap', 'key' => 'TENANT_BOOTSTRAP_PASSWORD'} && !login_container.key?('envFrom')
  abort 'login Job must use TLS verify-full and the RDS CA' unless login_container.fetch('env').any? { |env| env['name'] == 'PGSSLMODE' && env['value'] == 'verify-full' } && login_container.fetch('env').any? { |env| env['name'] == 'PGSSLROOTCERT' && env['value'] == '/rds-ca/ca.pem' }
  abort 'login Job must reconcile after credential rotation' unless login_job.dig('metadata', 'name').include?('login-')
  rotated_values = operational_values.merge('tenantBootstrapVersion' => 'version-rotation-3')
  rotated_output, rotated_error, rotated_status = Open3.capture3('helm', 'template', 'rds-bootstrap', File.join(root, 'rds-bootstrap-chart'), '--namespace', 'greenguard', '--set', 'operationalOnly=true', '--set', "rdsHost=#{rotated_values['rdsHost']}", '--set', "name=#{rotated_values['name']}", '--set', "credentialSecret=#{rotated_values['credentialSecret']}", '--set', "tenantBootstrapSecret=#{rotated_values['tenantBootstrapSecret']}", '--set', "tenantBootstrapVersion=#{rotated_values['tenantBootstrapVersion']}", '--set', "tenantBootstrapRole=#{rotated_values['tenantBootstrapRole']}")
  abort "rotated RDS bootstrap render failed: #{rotated_error}" unless rotated_status.success?
  rotated_job = YAML.safe_load_stream(rotated_output).compact.find { |object| object.fetch('kind') == 'Job' && object.dig('metadata', 'name').include?('-login-') }
  abort 'tenant bootstrap version rotation did not change the login Job identity' unless rotated_job && rotated_job.dig('metadata', 'name') != login_job.dig('metadata', 'name')
  abort 'login Job must not receive app/migrator credentials via envFrom' if login_container.key?('envFrom')
  abort 'login Job must have a bounded deadline and no API token' unless login_job.dig('spec', 'activeDeadlineSeconds').to_i.positive? && login_job.dig('spec', 'template', 'spec', 'automountServiceAccountToken') == false
end
_, _, accepted = Open3.capture3('helm', 'template', 'migration-gate', File.join(root, 'migration-gate-chart'), '--namespace', 'greenguard')
abort 'owner migration gate failed open' if accepted.success?
puts 'RDS bootstrap chart renders with RDS role, TLS, Secret, and deadline controls; owner migration gate rejects release.'
