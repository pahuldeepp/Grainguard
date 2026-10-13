#!/usr/bin/env ruby
# Offline shape gate. Live Kubernetes scheduling, image startup and Redis
# cluster formation still require an EKS acceptance run.
require 'yaml'

root = __dir__
docs = Dir[File.join(root, '**', '*.yaml')].flat_map do |file|
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
kafka_container = kafka.dig('spec', 'template', 'spec', 'containers', 0)
kafka_env = kafka_container.fetch('env').to_h { |env| [env['name'], env['value']] }
abort 'Kafka must disable topic auto-creation and advertise the stable pod DNS name' unless
  kafka_env['KAFKA_AUTO_CREATE_TOPICS_ENABLE'] == 'false' &&
  kafka_env['KAFKA_ADVERTISED_LISTENERS'] ==
    'INTERNAL://kafka-0.kafka-headless.greenguard.svc.cluster.local:29092'
abort 'Kafka listeners must require PLAIN over TLS with default-deny KRaft ACLs' unless
  kafka_env['KAFKA_LISTENER_SECURITY_PROTOCOL_MAP'] == 'INTERNAL:SASL_SSL,CONTROLLER:SASL_SSL' &&
  kafka_env['KAFKA_SASL_ENABLED_MECHANISMS'] == 'PLAIN' &&
  kafka_env['KAFKA_SASL_MECHANISM_CONTROLLER_PROTOCOL'] == 'PLAIN' &&
  kafka_env['KAFKA_AUTHORIZER_CLASS_NAME'] == 'org.apache.kafka.metadata.authorizer.StandardAuthorizer' &&
  kafka_env['KAFKA_ALLOW_EVERYONE_IF_NO_ACL_FOUND'] == 'false' &&
  kafka_env['KAFKA_SUPER_USERS'] == 'User:broker;User:admin' &&
  kafka_env['KAFKA_SSL_KEYSTORE_TYPE'] == 'PKCS12' &&
  kafka_container.fetch('env').any? { |entry| entry['name'] == 'KAFKA_LISTENER_NAME_INTERNAL_PLAIN_SASL_JAAS_CONFIG' &&
    entry.dig('valueFrom', 'secretKeyRef', 'name') == 'greenguard-kafka-auth' } &&
  kafka_container.fetch('env').any? { |entry| entry['name'] == 'KAFKA_LISTENER_NAME_CONTROLLER_PLAIN_SASL_JAAS_CONFIG' &&
    entry.dig('valueFrom', 'secretKeyRef', 'name') == 'greenguard-kafka-auth' }
registry = find.call('Deployment', 'schema-registry')
registry_container = registry.dig('spec', 'template', 'spec', 'containers', 0)
abort 'schema registry must be private, pinned and probed' unless
  registry_container['image'].match?(/@sha256:[0-9a-f]{64}\z/) &&
  %w[startupProbe readinessProbe livenessProbe resources].all? { |key| registry_container.key?(key) } &&
  find.call('Service', 'schema-registry').dig('spec', 'type') == 'ClusterIP'
registry_env = registry_container.fetch('env').to_h { |env| [env['name'], env['value']] }
abort 'Schema Registry must require HTTPS/BASIC and authenticated TLS Kafka' unless
  registry_env['SCHEMA_REGISTRY_LISTENERS'] == 'https://0.0.0.0:8081' &&
  registry_env['SCHEMA_REGISTRY_AUTHENTICATION_METHOD'] == 'BASIC' &&
  registry_env['SCHEMA_REGISTRY_KAFKASTORE_SECURITY_PROTOCOL'] == 'SASL_SSL' &&
  registry_env['SCHEMA_REGISTRY_KAFKASTORE_SASL_MECHANISM'] == 'PLAIN' &&
  registry_container.fetch('env').any? { |entry| entry['name'] == 'SCHEMA_REGISTRY_KAFKASTORE_SASL_JAAS_CONFIG' &&
    entry.dig('valueFrom', 'secretKeyRef', 'name') == 'greenguard-kafka-auth' }
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
  abort 'not ready: Kafka ACL bootstrap and live Kafka/Registry TLS authentication remain unproven; Redis and RabbitMQ require proven mesh mTLS and live client credentials'
end

puts "disposable data contract: #{docs.length} Kubernetes objects checked"
