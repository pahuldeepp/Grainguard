#!/usr/bin/env ruby
# Reads only `terraform output -json edge_target_group_binding` output.
# It prints one Kubernetes manifest and never applies it.
require 'json'
require 'yaml'
abort 'usage: render-target-group-bindings.rb OUTPUT.json' unless ARGV.length == 1
raw = JSON.parse(File.read(ARGV.fetch(0)))
binding = raw.is_a?(Hash) && raw.key?('value') ? raw.fetch('value') : raw
abort 'expected a target group binding object' unless binding.is_a?(Hash)
namespace = binding.fetch('namespace')
name = binding.fetch('service_name')
port = binding.fetch('service_port')
pod_port = binding.fetch('pod_target_port')
arn = binding.fetch('target_group_arn')
abort 'Istio ingress Service contract drifted' unless namespace == 'istio-system' && name == 'istio-ingressgateway' && port == 80 && pod_port == 8080
unless arn.match?(/\Aarn:aws:elasticloadbalancing:[a-z]{2}-[a-z]+-\d:\d{12}:targetgroup\/[A-Za-z0-9-]+\/[a-f0-9]{16}\z/)
  abort 'invalid AWS target group ARN'
end
puts({
  'apiVersion' => 'elbv2.k8s.aws/v1beta1',
  'kind' => 'TargetGroupBinding',
  'metadata' => { 'name' => 'greenguard-mesh-ingress', 'namespace' => namespace },
  'spec' => {
    'serviceRef' => { 'name' => name, 'port' => port },
    'targetGroupARN' => arn,
    'targetType' => 'ip'
  }
}.to_yaml)
