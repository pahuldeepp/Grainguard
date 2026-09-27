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

{ 'rabbitmq' => 1, 'redis-cluster' => 6 }.each do |name, replicas|
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

puts "disposable data contract: #{docs.length} Kubernetes objects checked"
