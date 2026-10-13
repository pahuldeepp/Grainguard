#!/usr/bin/env ruby
require 'open3'
require 'yaml'

root = File.expand_path('../../..', __dir__)
terraform = File.read(File.join(root, 'infra/terraform/disposable/gitops.tf'))
%w[KAFKA_REQUIRE_TLS KAFKA_SECURITY_PROTOCOL KAFKA_SASL_MECHANISM KAFKA_TLS_CA_FILE greenguard-kafka-ca].each do |marker|
  abort "Terraform disposable release lost #{marker}" unless terraform.scan(marker).length >= 2
end

image = "example.invalid/greenguard@sha256:#{'a' * 64}"
%w[greenguard-bff greenguard-service].each do |chart|
  release = chart == 'greenguard-bff' ? 'bff' : 'read-api'
  command = ['helm', 'template', release, File.join(root, 'infra/helm', chart), '--namespace', 'greenguard', '--set-string', "image=#{image}", '--set-string', 'kafka.caSecretName=greenguard-kafka-ca']
  command += ['-f', File.join(root, 'infra/helm', chart, 'values/read-api.yaml')] if chart == 'greenguard-service'
  output, error, status = Open3.capture3(*command)
  abort "#{chart} render failed: #{error}" unless status.success?
  pod = YAML.load_stream(output).compact.find { |item| %w[Deployment Rollout].include?(item['kind']) }.dig('spec', 'template', 'spec')
  container = pod.fetch('containers').first
  abort "#{chart} lost Kafka CA mount" unless container.fetch('volumeMounts').any? { |item| item['name'] == 'kafka-ca' && item['mountPath'] == '/etc/greenguard/kafka' && item['readOnly'] == true }
  abort "#{chart} lost CA-only Secret projection" unless pod.fetch('volumes').any? { |item| item['name'] == 'kafka-ca' && item.dig('secret', 'secretName') == 'greenguard-kafka-ca' && item.dig('secret', 'items').map { |entry| entry['key'] }.sort == %w[ca.crt registry-ca.crt] }
end
puts 'Disposable BFF and runtime Kafka CA mounts and Terraform TLS settings pass offline checks.'
