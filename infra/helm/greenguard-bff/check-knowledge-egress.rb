#!/usr/bin/env ruby
# Render only. No cluster discovery, credentials or installation.
require 'open3'
require 'yaml'
chart = __dir__
base = ['helm', 'template', 'bff', chart, '--namespace', 'greenguard', '--set-string', "image=example/bff@sha256:#{'a' * 64}"]
check = lambda do |args, namespace, name, release, port|
  output, error, status = Open3.capture3(*(base + args))
  abort "BFF render failed: #{error}" unless status.success?
  objects = YAML.safe_load_stream(output).compact
  policy = objects.find { |object| object['kind'] == 'NetworkPolicy' } or abort 'network policy missing'
  abort 'egress policy disabled' unless policy.dig('spec', 'policyTypes').include?('Egress')
  matches = policy.dig('spec', 'egress').select do |rule|
    peers = rule.fetch('to', [])
    peers.any? { |peer| peer.dig('podSelector', 'matchLabels', 'app.kubernetes.io/name') == name }
  end
  abort 'knowledge peer must have exactly one rule' unless matches.length == 1
  rule = matches.first
  abort 'knowledge peer must be singular' unless rule.fetch('to').length == 1
  peer = rule.fetch('to').first
  abort 'knowledge namespace must be constrained' unless peer.dig('namespaceSelector', 'matchLabels') == {'kubernetes.io/metadata.name' => namespace}
  abort 'knowledge pod labels must both be constrained' unless peer.dig('podSelector', 'matchLabels') == {'app.kubernetes.io/name' => name, 'app.kubernetes.io/instance' => release}
  abort 'knowledge port must be constrained' unless rule.fetch('ports') == [{'protocol' => 'TCP', 'port' => port}]
end
check.call([], 'greenguard-knowledge', 'knowledge-service', 'knowledge-api', 8080)
# Helm replaces arrays: the environment-specific values must include all other
# dependencies needed by that deployment. This case tests only the selected peer.
check.call(['--set', 'networkPolicy.egressServices[0].namespace=isolated-knowledge', '--set', 'networkPolicy.egressServices[0].name=private-knowledge', '--set', 'networkPolicy.egressServices[0].release=private-api', '--set', 'networkPolicy.egressServices[0].port=8443'], 'isolated-knowledge', 'private-knowledge', 'private-api', 8443)
puts 'PASS: rendered default and custom knowledge egress remain namespace/pod/TCP-port constrained'
