#!/usr/bin/env ruby
# Verify that the disposable Helm release names select the peers they permit.
require 'open3'
require 'yaml'
require 'json'
require 'tempfile'

ROOT = File.expand_path('../../..', __dir__)
terraform_cni = File.read(File.join(ROOT, 'infra/terraform/platform/main.tf'))
abort 'EKS VPC CNI NetworkPolicy support is not configured' unless
  terraform_cni.match?(/configuration_values\s*=\s*each\.value == "vpc-cni" \? jsonencode\(\{ enableNetworkPolicy = "true" \}\)/) &&
  terraform_cni.include?('var.vpc_cni_addon_version')
IMAGE = 'example.invalid/greenguard@sha256:' + ('a' * 64)
RELEASES = JSON.parse(File.read(File.join(ROOT, 'infra/gitops/disposable/contract.json')))
                .fetch('releases').to_h do |release|
  [release.fetch('name'), [release.fetch('chart'), release['profile']]]
end.freeze
EDGES = [
  %w[dashboard gateway 4002],
  %w[dashboard device-service 3001],
  %w[dashboard telemetry-ingest 8080],
  %w[gateway bff 4000],
  %w[gateway read-api 4001],
  %w[gateway saga-api 8092],
  %w[bff read-api 4001],
  %w[bff workflow-alerts 3004],
  %w[bff saga-api 8092],
  %w[bff tenant-control-plane 3010],
  %w[gateway tenant-control-plane 3010],
  %w[read-api tenant-control-plane 3010],
  %w[device-service tenant-control-plane 3010],
  %w[workflow-alerts tenant-control-plane 3010],
  %w[notification-service tenant-control-plane 3010]
].freeze
DATA_EDGES = {
  'bff' => %w[redis kafka],
  'gateway' => %w[redis kafka],
  'device-service' => %w[redis kafka],
  'read-api' => %w[redis kafka],
  'workflow-alerts' => %w[kafka redis],
  'telemetry-ingest' => %w[kafka],
  'cdc-transformer' => %w[kafka],
  'projection-builder' => %w[kafka],
  'cache-invalidator' => %w[kafka redis],
  'risk-engine' => %w[kafka],
  'hardware-service-worker' => %w[kafka mqtt],
  'eventbridge-bridge' => %w[kafka],
  'saga-api' => %w[kafka redis],
  'saga-worker' => %w[kafka],
  'billing-service' => %w[kafka],
  'notification-service' => %w[rabbit kafka redis],
  'notification-contacts-projector' => %w[kafka registry],
  'entitlement-heartbeat' => %w[kafka],
  'tenant-control-plane' => %w[kafka],
  'jobs-worker' => %w[rabbit kafka],
  'cassandra-writer' => %w[kafka],
  'search-indexer' => %w[kafka]
}.freeze
DATA_PEERS = { 'kafka' => ['kafka', 29092], 'redis' => ['redis-cluster', 6379],
               'rabbit' => ['rabbitmq', 5672], 'mqtt' => ['greenguard-mqtt', 8883],
               'registry' => ['schema-registry', 8081] }.freeze

def render(release, chart, profile)
  chart_dir = File.join(ROOT, 'infra/helm', chart)
  args = ['helm', 'template', release, chart_dir, '--namespace', 'greenguard', '--set', "image=#{IMAGE}"]
  args += ['-f', File.join(chart_dir, 'values', "#{profile}.yaml")] if profile
  output, error, status = Open3.capture3(*args)
  abort "#{release}: helm template failed: #{error}" unless status.success?
  objects = YAML.load_stream(output).compact
  workload = objects.find { |item| %w[Deployment Rollout].include?(item['kind']) }
  policy = objects.find { |item| item['kind'] == 'NetworkPolicy' }
  abort "#{release}: missing workload or NetworkPolicy" unless workload && policy
  { labels: workload.dig('spec', 'template', 'metadata', 'labels'), policy: policy, workload: workload }
end

def allows?(rules, peer_labels, port, direction)
  Array(rules).any? do |rule|
    Array(rule['ports']).any? { |entry| entry['protocol'] == 'TCP' && entry['port'].to_i == port } &&
      Array(rule[direction]).any? do |peer|
        selected = peer.fetch('podSelector', {}).fetch('matchLabels', {})
        peer.dig('namespaceSelector', 'matchLabels', 'kubernetes.io/metadata.name') == 'greenguard' &&
          selected.keys.sort == %w[app.kubernetes.io/name app.kubernetes.io/instance].sort &&
          selected.all? do |key, value|
            peer_labels[key] == value
          end
      end
  end
end

rendered = RELEASES.to_h do |release, (chart, profile)|
  [release, render(release, chart, profile)]
end
contract_releases = JSON.parse(File.read(File.join(ROOT, 'infra/gitops/disposable/contract.json')))
                        .fetch('releases').map { |release| release.fetch('name') }
abort 'network peer inventory does not cover every runtime release' unless
  rendered.keys.sort == contract_releases.sort
EDGES.each do |source, target, port_text|
  port = Integer(port_text)
  source_release = rendered.fetch(source)
  target_release = rendered.fetch(target)
  source_policy = source_release.fetch(:policy).fetch('spec')
  target_policy = target_release.fetch(:policy).fetch('spec')
  abort "#{source} -> #{target}: egress peer/port missing" unless
    allows?(source_policy['egress'], target_release.fetch(:labels), port, 'to')
  abort "#{source} -> #{target}: ingress peer/port missing" unless
    allows?(target_policy['ingress'], source_release.fetch(:labels), port, 'from')
end
data_policies = YAML.load_stream(File.read(File.join(ROOT, 'infra/kubernetes/disposable-data/networkpolicy.yaml'))).compact
data_workloads = %w[kafka rabbitmq redis-cluster].flat_map do |name|
  YAML.load_stream(File.read(File.join(ROOT, "infra/kubernetes/disposable-data/#{name}.yaml"))).compact
end
data_workloads.concat(YAML.load_stream(File.read(File.join(ROOT, 'infra/kubernetes/disposable-data/registry/schema-registry.yaml'))).compact)
mqtt_output, mqtt_error, mqtt_status = Open3.capture3('helm', 'template', 'mqtt', File.join(ROOT, 'infra/gitops/disposable/mqtt-chart'), '--namespace', 'greenguard', '--set', "image=#{IMAGE}")
abort "MQTT chart render failed: #{mqtt_error}" unless mqtt_status.success?
mqtt_objects = YAML.load_stream(mqtt_output).compact
data_workloads.concat(mqtt_objects.select { |object| object['kind'] == 'StatefulSet' })
data_policies.concat(mqtt_objects.select { |object| object['kind'] == 'NetworkPolicy' })
DATA_PEERS.each_value do |label, port|
  abort "#{label}: no matching data workload" unless data_workloads.any? do |item|
    %w[StatefulSet Deployment].include?(item['kind']) && item.dig('spec', 'template', 'metadata', 'labels', 'app') == label &&
      item.dig('spec', 'template', 'spec', 'containers')&.any? do |container|
        container.fetch('ports', []).any? { |entry| entry['containerPort'] == port }
      end
  end
end
DATA_EDGES.each do |source, targets|
  egress = rendered.fetch(source).fetch(:policy).fetch('spec').fetch('egress')
  targets.each do |target|
    label, port = DATA_PEERS.fetch(target)
    abort "#{source} -> #{target}: exact data egress missing" unless egress.any? do |rule|
      rule.fetch('ports', []).any? { |entry| entry['protocol'] == 'TCP' && entry['port'] == port } &&
        rule.fetch('to', []).any? do |peer|
          peer.dig('namespaceSelector', 'matchLabels') == { 'kubernetes.io/metadata.name' => 'greenguard' } &&
            peer.dig('podSelector', 'matchLabels') == { 'app' => label }
        end
    end
    ingress = data_policies.find { |policy| policy.dig('spec', 'podSelector', 'matchLabels') == { 'app' => label } }
    abort "#{source} -> #{target}: data ingress missing" unless ingress && ingress.dig('spec', 'ingress')&.any? do |rule|
      rule.fetch('ports', []).any? { |entry| entry['protocol'] == 'TCP' && entry['port'] == port } &&
        rule.fetch('from', []).any? { |peer| target == 'mqtt' ?
          peer.dig('namespaceSelector', 'matchLabels') == { 'kubernetes.io/metadata.name' => 'greenguard' } &&
            peer.dig('podSelector', 'matchLabels') == rendered.fetch(source).fetch(:labels).slice('app.kubernetes.io/name', 'app.kubernetes.io/instance') : peer['podSelector'] == {} }
    end
  end
end
rendered.each do |release, object|
  object.fetch(:policy).fetch('spec').fetch('egress').each do |rule|
    abort "#{release}: broad egress peer" if rule.fetch('to', []).any? do |peer|
      peer.empty? || peer.dig('podSelector', 'matchLabels') == {} ||
        peer['ipBlock']&.then { |block| %w[0.0.0.0/0 ::/0].include?(block['cidr']) }
    end
  end
end
heartbeat = rendered.fetch('entitlement-heartbeat').fetch(:workload)
heartbeat_container = heartbeat.dig('spec', 'template', 'spec', 'containers')&.first
heartbeat_env_from = Array(heartbeat_container && heartbeat_container['envFrom'])
abort 'entitlement heartbeat must use the dedicated billing-service-config Secret' unless
  heartbeat.dig('spec', 'template', 'spec', 'serviceAccountName') == 'entitlement-heartbeat' &&
    heartbeat_env_from.any? { |source| source.dig('secretRef', 'name') == 'billing-service-config' } &&
    Array(heartbeat_container && heartbeat_container['args']).include?('packages/entitlements/dist/heartbeat.js')
contacts = rendered.fetch('notification-contacts-projector').fetch(:workload)
contacts_container = contacts.dig('spec', 'template', 'spec', 'containers')&.first
contacts_env_from = Array(contacts_container && contacts_container['envFrom'])
abort 'notification contacts projector must use its dedicated config and bound Pod Identity service account' unless
  contacts.dig('spec', 'template', 'spec', 'serviceAccountName') == 'notification-contacts-projector' &&
    contacts_env_from.any? { |source| source.dig('secretRef', 'name') == 'notification-contacts-projector-config' } &&
    Array(contacts_container && contacts_container['args']).include?('services/notification-service/dist/contacts-projector-main.js')
gitops_terraform = File.read(File.join(ROOT, 'infra/terraform/disposable/gitops.tf'))
abort 'hardware worker MQTT CA mount must be appended inside container.volumeMounts' unless
  gitops_terraform.match?(/volumeMounts\s*=\s*concat\([\s\S]*release\.name == "hardware-service-worker" \? \[\{ name = "mqtt-ca"/) &&
    !gitops_terraform.match?(/release\.name == "hardware-service-worker" \? \{ volumeMounts\s*=/)
hardware_profile = YAML.load_file(File.join(ROOT, 'infra/helm/greenguard-service/values/hardware-service-worker.yaml'))
hardware_mount_overlay = {
  'container' => {
    'volumeMounts' => Array(hardware_profile.dig('container', 'volumeMounts')) + [
      { 'name' => 'shard-registry', 'mountPath' => '/run/greenguard-shards', 'readOnly' => true },
      { 'name' => 'mqtt-ca', 'mountPath' => '/etc/greenguard/mqtt', 'readOnly' => true }
    ]
  }
}
Tempfile.create(['hardware-mount-overlay', '.yaml']) do |file|
  file.write(YAML.dump(hardware_mount_overlay))
  file.flush
  mount_output, mount_error, mount_status = Open3.capture3(
    'helm', 'template', 'hardware-service-worker', File.join(ROOT, 'infra/helm/greenguard-service'),
    '--namespace', 'greenguard', '--set', "image=#{IMAGE}",
    '-f', File.join(ROOT, 'infra/helm/greenguard-service/values/hardware-service-worker.yaml'),
    '-f', file.path
  )
  abort "hardware mount chart render failed: #{mount_error}" unless mount_status.success?
  hardware_workload = YAML.load_stream(mount_output).compact.find { |item| item['kind'] == 'Deployment' }
  hardware_container = hardware_workload&.dig('spec', 'template', 'spec', 'containers')&.first
  mount_names = Array(hardware_container && hardware_container['volumeMounts']).map { |mount| mount['name'] }
  abort 'hardware worker render must retain both MQTT CA and shard registry container mounts' unless
    %w[mqtt-ca shard-registry].all? { |name| mount_names.include?(name) }
end
_, rejected_error, rejected_status = Open3.capture3(
  'helm', 'template', 'reject-wide', File.join(ROOT, 'infra/helm/greenguard-service'),
  '--namespace', 'greenguard', '--set', "image=#{IMAGE}",
  '--set', 'networkPolicy.egressCIDRs[0].cidr=0.0.0.0/0',
  '--set', 'networkPolicy.egressCIDRs[0].port=443'
)
abort 'service chart accepted world-wide egress' if rejected_status.success? ||
  !rejected_error.include?('networkPolicy.egressCIDRs must not permit all destinations')
terraform = gitops_terraform
abort 'contacts projector must use the regional DynamoDB managed prefix list for bounded TLS egress' unless
  terraform.include?('data.aws_prefix_list.dynamodb[0].cidr_blocks') &&
    terraform.include?('release.name == "notification-contacts-projector"')
ddb = File.read(File.join(ROOT, 'infra/terraform/disposable/contacts-dynamodb.tf'))
abort 'contacts projector DynamoDB policy must remain PutItem-only and table-scoped' unless
  ddb.scan(/dynamodb:PutItem/).length >= 2 && !ddb.match?(/dynamodb:(?:\*|GetItem|Query|Scan|UpdateItem|DeleteItem)/) &&
    ddb.match?(/service_account\s*=\s*"notification-contacts-projector"/) && ddb.include?('count = var.enable_application_tree ? 1 : 0')
puts "Disposable network peers valid: #{EDGES.length} service links and #{DATA_EDGES.values.sum(&:length)} data links"
