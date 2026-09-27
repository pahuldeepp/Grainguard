#!/usr/bin/env ruby
# Structural gate for controller bootstrap. It deliberately performs no install.
require 'json'

abort 'usage: check-controllers.rb [--ready]' unless ARGV.empty? || ARGV == ['--ready']
directory = __dir__
data = JSON.parse(File.read(File.join(directory, 'controllers.json')))
abort 'unsupported controller schema' unless data.fetch('schemaVersion') == 1
controllers = data.fetch('order')
expected = %w[aws-load-balancer-controller istio-base istiod istio-ingressgateway keda argo-rollouts argocd]
names = controllers.map { |controller| controller.fetch('name') }
abort 'controller order drifted' unless names == expected
abort 'duplicate controller' unless names.uniq == names
controllers.each do |controller|
  abort "#{controller['name']}: missing namespace" unless controller.fetch('namespace').match?(/\A[a-z0-9-]+\z/)
  abort "#{controller['name']}: missing chart" unless controller.fetch('chart').match?(/\A[a-z0-9-]+\z/)
  abort "#{controller['name']}: no prerequisites" if controller.fetch('requires').empty?
end
abort 'missing load balancer controller values' unless File.file?(File.join(directory, 'aws-load-balancer-controller-values.yaml'))
puts "Controller inventory valid: #{controllers.length} ordered releases."
if ARGV == ['--ready']
  unpinned = controllers.reject { |controller| controller['version'].is_a?(String) && controller['version'].match?(/\A\d+\.\d+\.\d+\z/) }
  abort "Controller bootstrap blocked: pin chart versions for #{unpinned.map { |controller| controller['name'] }.join(', ')}" unless unpinned.empty?
  abort 'Controller bootstrap blocked: checksum-verified chart sources, Argo CD application tree, Terraform ownership, and live cluster preflight are not implemented'
end
