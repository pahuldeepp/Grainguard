#!/usr/bin/env ruby
require 'yaml'
require 'json'
require 'open3'
require 'tempfile'
root = __dir__
digest = "example.test/greenguard/data@sha256:#{'a' * 64}"
shards = %w[s1 s2 s3 s4].to_h { |id| [id, {
  'rdsHost' => "db-#{id}.example.us-east-1.rds.amazonaws.com",
  'bootstrapSecret' => "greenguard-#{id}-rds-bootstrap",
  'pgbouncerAuthSecret' => "greenguard-#{id}-pgbouncer-auth",
  'cdcSecret' => "greenguard-#{id}-cdc-credentials"
}] }
values = {
  'cell' => 'greenguard-shard-test', 'repositoryUrl' => 'https://example.test/greenguard.git', 'revision' => 'b' * 40,
  'observabilityImages' => %w[otel-collector prometheus grafana tempo loki].to_h { |name| [name,digest] },
  'dataPlane' => {
    'enabled' => true, 'rdsHost' => 'db-central.example.us-east-1.rds.amazonaws.com',
    'images' => %w[pgbouncer kafka-topics kafka-connect connector-registration].to_h { |name| [name,digest] },
    'secrets' => {'pgbouncerAuth'=>'greenguard-pgbouncer-auth', 'rdsCa'=>'greenguard-rds-ca', 'cdcCredentials'=>'greenguard-cdc-credentials'},
    'shards' => shards
  }
}
def render(root, chart, values)
  Tempfile.create(['shards-', '.yaml']) do |file|
    file.write(values.to_yaml)
    file.flush
    output, error, status = Open3.capture3('helm','template','shards',File.join(root,chart),'-f',file.path)
    raise "#{chart}: #{error}" unless status.success?
    YAML.safe_load_stream(output).compact
  end
end
apps = render(root,'applications-chart',values)
%w[s1 s2 s3 s4].each do |id|
  bootstrap = apps.find { |app| app.dig('metadata','name') == "greenguard-#{id}-rds-bootstrap" }
  pooler = apps.find { |app| app.dig('metadata','name') == "greenguard-#{id}-pgbouncer" }
  raise "missing #{id} bootstrap or pooler" unless bootstrap && pooler
  [bootstrap,pooler].each do |app|
    raise 'lost shard lifecycle ownership' unless app.dig('metadata','finalizers') == ['resources-finalizer.argocd.argoproj.io'] && app.dig('metadata','labels','greenguard.io/shard') == id
  end
  bootstrap_objects = render(root,'rds-bootstrap-chart',bootstrap.dig('spec','source','helm','valuesObject'))
  job = bootstrap_objects.find { |item| item['kind'] == 'Job' }
  raise 'operational bootstrap selected central databases' unless job.dig('spec','template','spec','containers',0,'args').include?('GG_OPERATIONAL_ONLY=1')
  raise 'bootstrap host can be overridden by a Secret' unless job.dig('spec','template','spec','containers',0,'env').any? { |entry| entry['name']=='PGHOST' && entry['value']==shards[id]['rdsHost'] }
  pool_objects = render(root,'pgbouncer-chart',pooler.dig('spec','source','helm','valuesObject'))
  service = pool_objects.find { |item| item['kind'] == 'Service' }
  raise 'pooler Service collides' unless service.dig('metadata','name') == "pgbouncer-#{id}"
  config = pool_objects.find { |item| item['kind'] == 'ConfigMap' }.dig('data','pgbouncer.ini')
  raise 'shard pooler targets wrong RDS host' unless config.include?(shards[id]['rdsHost'])
  raise 'shard pooler exposes central owner DBs' if config.match?(/^greenguard_(control|billing) =/)
end
connect = apps.find { |app| app.dig('metadata','name') == 'greenguard-kafka-connect' }
connect_objects = render(root,'kafka-connect-chart',connect.dig('spec','source','helm','valuesObject'))
env = connect_objects.find { |item| item['kind']=='Deployment' }.dig('spec','template','spec','containers',0,'env')
%w[s1 s2 s3 s4].each do |id|
  raise 'shard CDC credential missing' unless env.any? { |entry| entry['name']=="CDC_DB_PASSWORD_#{id.upcase}" && entry.dig('valueFrom','secretKeyRef','name')==shards[id]['cdcSecret'] }
end
registration = apps.find { |app| app.dig('metadata','name') == 'greenguard-connector-registration' }
registration_objects = render(root,'connector-registration',registration.dig('spec','source','helm','valuesObject'))
host_env = registration_objects.find { |item| item['kind']=='Job' }.dig('spec','template','spec','containers',0,'env').find { |entry| entry['name']=='SHARD_HOSTS_JSON' }
raise 'registration lost shard mapping' unless JSON.parse(host_env['value']) == shards.to_h { |id,shard| [id,shard['rdsHost']] }
root_app = render(root,'bootstrap-chart',values).fetch(0)
raise 'root failed to propagate shards' unless root_app.dig('spec','source','helm','valuesObject','dataPlane','shards') == shards
bad = Marshal.load(Marshal.dump(values)); bad['dataPlane']['shards'].delete('s4')
%w[bootstrap-chart applications-chart].each do |chart|
  begin
    render(root,chart,bad)
  rescue RuntimeError
    next
  end
  raise 'partial shard registry accepted'
end
puts 'Four shard bootstrap/pooler children, scoped credentials, registration hosts, central exclusion and reject fixtures passed.'

%w[bootstrap-chart applications-chart].each do |chart|
  ["same-shard", "central"].each do |collision|
    bad = Marshal.load(Marshal.dump(values))
    bad['dataPlane']['shards']['s4']['rdsHost'] = collision == "central" ? values['dataPlane']['rdsHost'].sub('db-central', 'DB-CENTRAL') : values['dataPlane']['shards']['s1']['rdsHost']
    begin
      render(root,chart,bad)
    rescue RuntimeError
      next
    end
    raise 'colliding physical shard endpoint accepted'
  end
end
begin
  render(root,'rds-bootstrap-chart', {'name'=>'a'*47})
  raise 'bootstrap job name can exceed 63 characters'
rescue RuntimeError => error
  raise error if error.message.include?('can exceed')
end
puts 'Case-insensitive physical endpoint collision and oversized bootstrap name reject fixtures passed.'
begin
  render(root,'rds-bootstrap-chart', {'operationalOnly'=>true, 'rdsHost'=>''})
  raise 'operational bootstrap accepted no explicit host'
rescue RuntimeError => error
  raise error if error.message.include?('accepted no explicit host')
end
puts 'Operational bootstrap without an explicit host rejected.'
