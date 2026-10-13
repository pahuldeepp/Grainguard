#!/usr/bin/env ruby
# A deliberately optimistic lower bound, not a complete scheduling simulation.
require 'yaml'
require 'json'
require 'rubygems/package'
require 'zlib'
require 'bigdecimal'

module MinimumCapacity
  module_function

  def merge(base, override)
    base.merge(override) { |_key, old, new| old.is_a?(Hash) && new.is_a?(Hash) ? merge(old, new) : new }
  end

  def millicpu(quantity)
    value = quantity.to_s
    raise "Unsupported CPU quantity: #{value}" unless /\A\d+(?:\.\d+)?m?\z/.match?(value)
    BigDecimal(value.delete_suffix('m')) * (value.end_with?('m') ? 1 : 1000)
  end

  def report(root)
    releases = JSON.parse(File.read("#{root}/infra/gitops/disposable/contract.json")).fetch('releases')
    apps = releases.map do |release|
      chart = "#{root}/infra/helm/#{release.fetch('chart')}"
      values = YAML.load_file("#{chart}/values.yaml")
      if release['profile']
        values = merge(values, YAML.load_file("#{chart}/values/#{release.fetch('profile')}.yaml"))
      end
      { 'name' => release.fetch('name'), 'millicpu' => millicpu(values.fetch('resources').fetch('requests').fetch('cpu')).to_i }
    end
    archive = "#{root}/infra/helm/controller-charts/istiod-1.30.5.tgz"
    proxy = nil
    Zlib::GzipReader.open(archive) do |gzip|
      Gem::Package::TarReader.new(gzip) do |tar|
        tar.each { |entry| proxy = YAML.safe_load(entry.read).fetch('_internal_defaults_do_not_set').fetch('global').fetch('proxy').fetch('resources').fetch('requests').fetch('cpu') if entry.full_name == 'istiod/values.yaml' }
      end
    end
    raise 'Pinned Istio proxy CPU request not found' unless proxy
    data = %w[kafka rabbitmq redis-cluster].map do |name|
      docs = YAML.load_stream(File.read("#{root}/infra/kubernetes/disposable-data/#{name}.yaml"))
      workload = docs.find { |doc| doc && doc['kind'] == 'StatefulSet' }
      spec = workload.fetch('spec')
      cpu = spec.fetch('template').fetch('spec').fetch('containers').sum { |container| millicpu(container.fetch('resources').fetch('requests').fetch('cpu')) }
      { 'name' => name, 'millicpu' => (cpu * spec.fetch('replicas')).to_i }
    end
    application_cpu = apps.sum { |app| app.fetch('millicpu') }
    proxy_cpu = (apps.length * millicpu(proxy)).to_i
    total = application_cpu + proxy_cpu + data.sum { |item| item.fetch('millicpu') }
    {
      'assumption' => 'One pod per required application; existing container and mesh CPU requests preserved. No replica reduction has been applied.',
      'application_count' => apps.length,
      'application_millicpu' => application_cpu,
      'mesh_millicpu' => proxy_cpu,
      'data' => data,
      'lower_bound_millicpu' => total,
      'fits_8_vcpus_even_before_node_overhead' => total <= 8000,
      'excluded' => ['Cassandra', 'OpenSearch', 'ClickHouse', 'Kafka Connect', 'schema registry', 'PgBouncer', 'Dex', 'AI/ML', 'observability', 'controllers', 'DaemonSets', 'node reservations', 'migration/acceptance jobs', 'surge capacity']
    }
  end
end

puts JSON.pretty_generate(MinimumCapacity.report(File.expand_path('../../..', __dir__))) if $PROGRAM_NAME == __FILE__
