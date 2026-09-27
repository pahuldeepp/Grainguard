#!/usr/bin/env ruby
# Offline shape gate. Live Kubernetes scheduling, image startup and Redis
# cluster formation still require an EKS acceptance run.
require 'yaml'

root = __dir__
docs = Dir[File.join(root, '*.yaml')].flat_map do |file|
  YAML.load_stream(File.read(file)).compact
end
abort 'no disposable data manifests found' if docs.empty?

find = lambda do |kind, name|
  docs.find { |d| d['kind'] == kind && d.dig('metadata', 'name') == name } ||
    abort("missing #{kind}/#{name}")
end

storage = find.call('StorageClass', 'greenguard-disposable-gp3')
abort 'storage must use EBS CSI gp3 with delete reclaim' unless
  storage['provisioner'] == 'ebs.csi.aws.com' &&
  storage.dig('parameters', 'type') == 'gp3' &&
  storage.dig('parameters', 'encrypted') == 'true' &&
  storage['reclaimPolicy'] == 'Delete'

quarantine = find.call('PersistentVolumeClaim', 'search-indexer-quarantine')
abort 'search indexer quarantine must be disposable encrypted gp3 storage' unless
  quarantine.dig('metadata', 'namespace') == 'greenguard' &&
  quarantine.dig('metadata', 'labels', 'greenguard.io/lifecycle') == 'disposable' &&
  quarantine.dig('spec', 'storageClassName') == 'greenguard-disposable-gp3' &&
  quarantine.dig('spec', 'accessModes') == ['ReadWriteOnce'] &&
  quarantine.dig('spec', 'resources', 'requests', 'storage') == '8Gi'

{ 'rabbitmq' => 1, 'redis-cluster' => 6, 'kafka' => 1 }.each do |name, replicas|
  stateful = find.call('StatefulSet', name)
  abort "#{name} replicas changed" unless stateful.dig('spec', 'replicas') == replicas
  abort "#{name} must stay private" unless
    docs.select { |d| d['kind'] == 'Service' && d.dig('spec', 'selector', 'app') == name }
      .all? { |service| %w[ClusterIP None].include?(service.dig('spec', 'type') || service.dig('spec', 'clusterIP')) }
  pod = stateful.dig('spec', 'template', 'spec')
  abort "#{name} must run non-root without API token" unless
    pod['automountServiceAccountToken'] == false && pod.dig('securityContext', 'runAsNonRoot') == true
  container = pod.fetch('containers').first
  abort "#{name} image must be pinned to sha256" unless container['image'].match?(/@sha256:[0-9a-f]{64}\z/)
  abort "#{name} probes/resources missing" unless
    %w[startupProbe readinessProbe livenessProbe resources].all? { |key| container.key?(key) }
  abort "#{name} must drop capabilities" unless
    container.dig('securityContext', 'capabilities', 'drop') == ['ALL']
  claim = stateful.dig('spec', 'volumeClaimTemplates')&.first
  abort "#{name} must own a disposable gp3 PVC" unless
    claim&.dig('spec', 'storageClassName') == 'greenguard-disposable-gp3'
end

redis = find.call('StatefulSet', 'redis-cluster')
abort 'Redis must start all nodes before bootstrap' unless redis.dig('spec', 'podManagementPolicy') == 'Parallel'
abort 'Redis bootstrap job missing' unless find.call('Job', 'redis-cluster-bootstrap')
abort 'Redis password must come from Secret' unless
  redis.dig('spec', 'template', 'spec', 'containers', 0, 'env', 0, 'valueFrom', 'secretKeyRef', 'key') == 'REDIS_PASSWORD'

rabbit = find.call('StatefulSet', 'rabbitmq')
secret_keys = rabbit.dig('spec', 'template', 'spec', 'containers', 0, 'env').filter_map do |item|
  item.dig('valueFrom', 'secretKeyRef', 'key')
end
abort 'RabbitMQ credentials must come from Secret' unless
  %w[RABBITMQ_DEFAULT_USER RABBITMQ_DEFAULT_PASS RABBITMQ_ERLANG_COOKIE].all? { |key| secret_keys.include?(key) }

kafka = find.call('StatefulSet', 'kafka')
kafka_env = kafka.dig('spec', 'template', 'spec', 'containers', 0, 'env').to_h { |env| [env['name'], env['value']] }
abort 'Kafka must disable topic auto-creation and advertise the stable pod DNS name' unless
  kafka_env['KAFKA_AUTO_CREATE_TOPICS_ENABLE'] == 'false' &&
  kafka_env['KAFKA_ADVERTISED_LISTENERS'] ==
    'INTERNAL://kafka-0.kafka-headless.greenguard.svc.cluster.local:29092'
registry = find.call('Deployment', 'schema-registry')
registry_container = registry.dig('spec', 'template', 'spec', 'containers', 0)
abort 'schema registry must be private, pinned and probed' unless
  registry_container['image'].match?(/@sha256:[0-9a-f]{64}\z/) &&
  %w[startupProbe readinessProbe livenessProbe resources].all? { |key| registry_container.key?(key) } &&
  find.call('Service', 'schema-registry').dig('spec', 'type') == 'ClusterIP'
{
  'rabbitmq' => [5672], 'redis' => [6379, 16379],
  'kafka' => [29092, 9093], 'schema-registry' => [8081]
}.each do |name, ports|
  policy = find.call('NetworkPolicy', "disposable-#{name}-ingress")
  ingress = policy.dig('spec', 'ingress') || []
  actual_ports = ingress.flat_map { |rule| rule.fetch('ports', []).map { |port| port['port'] } }
  abort "#{name} ingress port contract changed" unless actual_ports.sort == ports.sort
  abort "#{name} network policy must select only its workload" unless
    policy.dig('spec', 'podSelector', 'matchLabels', 'app') ==
      (name == 'redis' ? 'redis-cluster' : name)
  abort "#{name} ingress must remain namespace-local and pod-selected" unless
    policy.dig('metadata', 'namespace') == 'greenguard' &&
    policy.dig('spec', 'policyTypes') == ['Ingress'] &&
    ingress.all? do |rule|
      rule['from'].is_a?(Array) && !rule['from'].empty? && rule['from'].all? do |source|
        source.key?('podSelector') && !source.key?('namespaceSelector') && !source.key?('ipBlock')
      end
    end
end

if ARGV.include?('--ready')
  abort 'not ready: Kafka and Schema Registry lack client authentication and TLS; Redis and RabbitMQ require proven mesh mTLS and live client credentials'
end

puts "disposable data contract: #{docs.length} Kubernetes objects checked"
