#!/usr/bin/env ruby
require 'open3'
require 'yaml'

root = File.expand_path('../../..', __dir__)
image = 'example.test/greenguard/audit@sha256:' + ('a' * 64)
render = lambda do |name, chart, *args|
  output, error, status = Open3.capture3('helm', 'template', name, File.join(root, chart), '--namespace', 'greenguard', *args)
  abort "#{name}: Helm render failed: #{error}" unless status.success?
  YAML.safe_load_stream(output).compact
end

clients = {
  'read-api' => [['greenguard-opensearch', 9200], ['greenguard-cassandra', 9042]],
  'search-indexer' => [['greenguard-opensearch', 9200]],
  'cassandra-writer' => [['greenguard-cassandra', 9042]]
}
clients.each do |name, peers|
  objects = render.call(name, 'infra/helm/greenguard-service', '--set', "image=#{image}",
                        '-f', File.join(root, "infra/helm/greenguard-service/values/#{name}.yaml"))
  policy = objects.find { |item| item['kind'] == 'NetworkPolicy' }
  abort "#{name}: NetworkPolicy missing" unless policy
  peers.each do |label, port|
    present = policy.dig('spec', 'egress').any? do |rule|
      rule.fetch('ports', []).any? { |entry| entry['protocol'] == 'TCP' && entry['port'] == port } &&
        rule.fetch('to', []).any? do |peer|
          peer.dig('namespaceSelector', 'matchLabels') == { 'kubernetes.io/metadata.name' => 'greenguard' } &&
            peer.dig('podSelector', 'matchLabels') == { 'app' => label }
        end
    end
    abort "#{name}: exact #{label}:#{port} egress missing" unless present
  end
end

search = render.call('greenguard-opensearch', 'infra/helm/greenguard-opensearch',
                     '--set', "image=#{image}", '--set', "bootstrap.image=#{image}")
search_policy = search.find { |item| item['kind'] == 'NetworkPolicy' && item.dig('metadata', 'name') == 'greenguard-opensearch' }
abort 'OpenSearch ingress policy missing' unless search_policy
%w[read-api search-indexer].each do |name|
  abort "OpenSearch ingress lacks #{name}" unless search_policy.dig('spec', 'ingress').any? do |rule|
    rule.fetch('ports', []).any? { |entry| entry['port'] == 9200 } &&
      rule.fetch('from', []).any? { |peer| peer.dig('podSelector', 'matchLabels') == { 'app.kubernetes.io/name' => name } }
  end
end

cassandra = render.call('greenguard-cassandra', 'infra/gitops/disposable/cassandra-chart',
  '--set', "cassandraImage=#{image}", '--set', "migratorImage=#{image}",
                        '--set', 'authSecret=greenguard-cassandra-auth', '--set', 'tlsSecret=greenguard-cassandra-tls',
                        '--set', 'apiServerCIDR=10.100.0.1/32')
base = cassandra.find { |item| item['kind'] == 'NetworkPolicy' && item.dig('metadata', 'name') == 'greenguard-cassandra' }
client = cassandra.find { |item| item['kind'] == 'NetworkPolicy' && item.dig('metadata', 'name') == 'greenguard-cassandra-clients' }
abort 'Cassandra base or client policy missing' unless base && client
abort 'Cassandra base policy admits client pods before auth bootstrap' if base.dig('spec', 'ingress').any? do |rule|
  rule.fetch('from', []).any? { |peer| peer.dig('podSelector', 'matchLabels')&.key?('app.kubernetes.io/name') }
end
abort 'Cassandra client policy lacks post-bootstrap label gate' unless
  client.dig('spec', 'podSelector', 'matchLabels', 'greenguard.io/cassandra-auth-ready') == 'true'
expressions = client.dig('spec', 'ingress', 0, 'from', 0, 'podSelector', 'matchExpressions')
abort 'Cassandra client identities drifted' unless expressions == [
  { 'key' => 'app.kubernetes.io/name', 'operator' => 'In', 'values' => %w[read-api cassandra-writer] }
]
abort 'Cassandra client port drifted' unless client.dig('spec', 'ingress', 0, 'ports') == [{ 'protocol' => 'TCP', 'port' => 9042 }]

puts 'Auxiliary data peers valid: four exact OpenSearch/Cassandra egress links and gated ingress.'
