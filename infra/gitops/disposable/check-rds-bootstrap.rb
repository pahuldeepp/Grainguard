#!/usr/bin/env ruby
require 'yaml'
require 'open3'
require 'digest'

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
_, _, accepted = Open3.capture3('helm', 'template', 'migration-gate', File.join(root, 'migration-gate-chart'), '--namespace', 'greenguard')
abort 'owner migration gate failed open' if accepted.success?
puts 'RDS bootstrap chart renders with RDS role, TLS, Secret, and deadline controls; owner migration gate rejects release.'
