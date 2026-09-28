#!/usr/bin/env ruby
require 'yaml'
require 'json'
require 'open3'
require 'tempfile'
root = __dir__
# Expected coverage is independent of the Helm helper's inventory.
operational = %w[telemetry projection jobs saga hardware inventory alerts risk notifications]
central = %w[control billing]
owners = central + operational
digest = "example.test/migrate@sha256:#{'a' * 64}"
values = {
  'rdsCIDRs'=>['10.1.0.0/20'], 'apiServerCIDR'=>'172.20.0.1/32',
  'revision' => 'b' * 40, 'caSecret' => 'greenguard-rds-ca',
  'images' => owners.to_h { |owner| [owner, digest] },
  'scopes' => %w[central s1 s2 s3 s4].to_h { |scope| [scope, {
    'rdsHost' => "#{scope}.test.us-east-1.rds.amazonaws.com",
    'secrets' => (scope == 'central' ? central : operational).to_h { |owner| [owner, "#{scope}-#{owner}-migrator"] }
  }] },
  'gateImage' => "example.test/kubectl@sha256:#{'c' * 64}",
  'sqlImage' => "example.test/postgres@sha256:#{'d' * 64}"
}
render = lambda do |chart, fixture|
  Tempfile.create(['owner-migrations-', '.yaml']) do |file|
    file.write(fixture.to_yaml); file.flush
    Open3.capture3('helm', 'template', 'owner-migrations', File.join(root, chart), '--namespace', 'greenguard', '-f', file.path)
  end
end
%w[owner-migrations-chart migration-gate-chart].each do |chart|
  _, _, status = render.call(chart, {})
  abort "#{chart} default failed open" if status.success?
end
output, error, status = render.call('owner-migrations-chart', values)
abort error unless status.success?
migration_docs = YAML.safe_load_stream(output).compact
jobs = migration_docs.select { |d| d['kind']=='Job' }
expected = %w[central].product(central) + %w[s1 s2 s3 s4].product(operational)
actual = jobs.map { |job| [job.dig('metadata', 'labels', 'greenguard.io/migration-scope'), job.dig('metadata', 'labels', 'greenguard.io/migration-owner')] }
abort 'owner migration coverage drifted' unless actual.sort == expected.sort && jobs.length == 38
names = jobs.map { |job| job.dig('metadata', 'name') }
abort 'duplicate migration Job' unless names.uniq == names
jobs.each do |job|
  abort 'migration sidecar can block completion' unless job.dig('spec','template','metadata','annotations','sidecar.istio.io/inject') == 'false'
  pod = job.dig('spec', 'template', 'spec'); container = pod.fetch('containers').first
  scope, owner = job.dig('metadata', 'labels').values_at('greenguard.io/migration-scope', 'greenguard.io/migration-owner')
  credential = container.fetch('env').find { |entry| entry['name'].end_with?('_MIGRATION_URL') }
  abort 'scope credential drifted' unless credential.dig('valueFrom', 'secretKeyRef', 'name') == "#{scope}-#{owner}-migrator"
  abort 'runtime image used as migration' unless container['image'] == digest
  abort 'migration TLS context missing' unless container.fetch('env').any? { |entry| entry == {'name'=>'GG_RDS','value'=>'1'} }
  abort 'CA mount missing' unless pod.fetch('volumes').any? { |v| v.dig('secret','items') == [{'key'=>'ca.pem','path'=>'ca.pem'}] }
  abort 'migration bound missing' unless job.dig('spec','activeDeadlineSeconds') == 900
end
output, error, status = render.call('migration-gate-chart', values)
abort error unless status.success?
gate_docs = YAML.safe_load_stream(output).compact
gate = gate_docs.find { |d| d['kind']=='Job' }; role = gate_docs.find { |d| d['kind']=='Role' }
abort 'gate can inspect unrelated Jobs' unless role.dig('rules',0,'resourceNames').sort == names.sort
abort 'migration acceptance Job selector label missing' unless gate.dig('metadata', 'labels', 'greenguard.io/migration-gate') == 'true'
abort 'gate sidecar can block completion' unless gate.dig('spec','template','metadata','annotations','sidecar.istio.io/inject') == 'false'
pod = gate.dig('spec','template','spec'); init = pod.fetch('initContainers')
abort 'gate did not check all SQL owners' unless init.length == 39
wait = init.first.fetch('args').first
abort 'gate does not wait exact migration Jobs' unless names.all? { |name| wait.include?("job/#{name}") }
init.drop(1).each do |container|
  script = container.fetch('args').first
  %w[END; ON_ERROR_STOP current_database current_user relforcerowsecurity has_table_privilege].each { |marker| abort "SQL gate missing #{marker}" unless script.include?(marker) }
  if !container['name'].start_with?('central-')
    %w[admit_tenant_placement enforce_tenant_ownership forbid_tenant_truncate has_function_privilege tgtype=31 tgtype=34].each { |marker| abort "fence gate missing #{marker}" unless script.include?(marker) }
  end
  abort 'SQL checker mounts API token' if container.fetch('volumeMounts').any? { |m| m['name']=='api' }
end
root_values = {'revision'=>values['revision'], 'cell'=>'test-cell', 'repositoryUrl'=>'https://example.test/repo.git', 'observabilityImages'=>%w[otel-collector prometheus grafana tempo loki].to_h { |name| [name,digest] }, 'ownerMigrations'=>values.reject { |k,_| k=='revision' }}
output, error, status = render.call('applications-chart', root_values)
abort error unless status.success?
apps = YAML.safe_load_stream(output).compact
migration = apps.find { |d| d.dig('metadata','name')=='greenguard-owner-migrations' }
gate_app = apps.find { |d| d.dig('metadata','name')=='greenguard-migration-gate' }
abort 'migration owner Application missing' unless migration.dig('spec','source','path').end_with?('owner-migrations-chart')
abort 'gate missing full checked configuration' unless gate_app.dig('spec','source','helm','valuesObject','scopes') == values['scopes']
abort 'runtime gate wave ordering drifted' unless migration.dig('metadata','annotations','argocd.argoproj.io/sync-wave').to_i < gate_app.dig('metadata','annotations','argocd.argoproj.io/sync-wave').to_i
mutations = [
  ->(v){v['scopes'].delete('s4')}, ->(v){v['images'].delete('risk')},
  ->(v){v['images']['risk']='example.test/risk:latest'}, ->(v){v['scopes']['s2']['secrets'].delete('jobs')},
  ->(v){v['scopes']['s3']['rdsHost']=v['scopes']['s2']['rdsHost']},
  ->(v){v['caSecret']=''}, ->(v){v['revision']='main'},
  ->(v){v['scopes']['central']['secrets']['jobs']='unexpected'},
  ->(v){v['images']['unexpected']=digest}, ->(v){v['rdsCIDRs']=[]}, ->(v){v['rdsCIDRs']=['0.0.0.0/0']}, ->(v){v['apiServerCIDR']='0.0.0.0/0'}
]
mutations.each do |mutate|
  bad=Marshal.load(Marshal.dump(values)); mutate.call(bad)
  %w[owner-migrations-chart migration-gate-chart].each do |chart|
    _,_,status=render.call(chart,bad); abort "#{chart} accepted incomplete/unsafe config" if status.success?
  end
end
%w[gateImage sqlImage].each do |key|
  bad=Marshal.load(Marshal.dump(values)); bad[key]='example.test/tool:latest'
  _,_,status=render.call('migration-gate-chart',bad);abort 'gate accepted mutable tool' if status.success?
end
puts '38 central/shard owner Jobs, exact dependency inventory and SQL grant/RLS/fence gate render; missing configuration stays closed.'

%w[telemetry-ingest projection-builder jobs-worker saga-orchestrator hardware-service].each do |service|
  dockerfile = File.read(File.join(root, "../../../services/#{service}/Dockerfile"))
  abort "#{service} migration image target missing" unless dockerfile.include?('FROM scratch AS migration') && dockerfile.include?('FROM scratch AS runtime')
end

%w[device-service workflow-alerts tenant-control-plane billing-service notification-service].each do |service|
  dockerfile = File.read(File.join(root, "../../../services/#{service}/Dockerfile"))
  abort "#{service} Prisma migration image target missing" unless dockerfile.include?('FROM build AS migration') && dockerfile.include?('FROM build AS production-deps') && dockerfile.include?('AS runtime') && dockerfile.include?('verify-migration-url.mjs')
end

risk_dockerfile = File.read(File.join(root, '../../../services/risk-engine/Dockerfile'))
abort 'risk Python migration image target missing' unless risk_dockerfile.include?('FROM base AS migration') && risk_dockerfile.include?('FROM base AS runtime') && risk_dockerfile.include?('verify-migration-url.py')


helper_paths = ['owner-migrations-chart/templates/_helpers.tpl', 'migration-gate-chart/templates/_helpers.tpl', 'applications-chart/templates/_owner-migrations.tpl']
abort 'migration helper contracts drifted' unless helper_paths.map { |path| File.read(File.join(root,path)) }.uniq.length == 1
abort 'independent migration inventory drifted' unless JSON.parse(File.read(File.join(root,'owner-migration-inventory.json'))).map { |owner| owner['name'] }.sort == owners.sort
[migration_docs,gate_docs].each do |documents|
  policy=documents.find { |d| d['kind']=='NetworkPolicy' }
  abort 'migration network policy absent' unless policy && policy.dig('spec','ingress')==[]
  ports=policy.dig('spec','egress').flat_map { |rule| rule['ports'].map { |port| port['port'] } }.sort
  abort 'migration network policy excessive ports' unless ports == (documents==migration_docs ? [53,53,5432] : [53,53,443,5432]).sort
end
