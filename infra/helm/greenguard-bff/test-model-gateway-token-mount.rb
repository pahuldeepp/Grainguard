#!/usr/bin/env ruby
# Render-only check for protected tenant-scoped Gateway credentials.
require 'open3'
require 'yaml'

chart = __dir__
base = ['helm', 'template', 'bff', chart, '--namespace', 'greenguard', '--set-string', "image=example/bff@sha256:#{'a' * 64}"]
render = lambda do |args|
  stdout, stderr, status = Open3.capture3(*(base + args))
  [stdout, stderr, status]
end

stdout, stderr, status = render.call([])
abort "default BFF render failed: #{stderr}" unless status.success?
default_deployment = YAML.load_stream(stdout).compact.find { |object| object['kind'] == 'Deployment' }
default_pod = default_deployment.dig('spec', 'template', 'spec')
abort 'disabled token feature must not inject an init container' unless (default_pod['initContainers'] || []).empty?
abort 'disabled token feature must not mount a secret' if (default_pod['volumes'] || []).any? { |volume| volume['name'].to_s.include?('model-gateway-token') }

stdout, stderr, status = render.call(['--set', 'modelGatewayTokens.enabled=true'])
abort "enabled BFF render failed: #{stderr}" unless status.success?
deployment = YAML.load_stream(stdout).compact.find { |object| object['kind'] == 'Deployment' }
pod = deployment.dig('spec', 'template', 'spec')
init = pod.fetch('initContainers').find { |container| container['name'] == 'materialize-model-gateway-tokens' } or abort 'token materializer missing'
abort 'token init must run non-root as the BFF UID' unless init.dig('securityContext', 'runAsUser') == 101
abort 'token init must copy then restrict file permissions' unless init.dig('command', 2).include?('chmod 0600')
secret_volume = pod.fetch('volumes').find { |volume| volume['name'] == 'model-gateway-tokens-projected' } or abort 'projected token Secret missing'
abort 'projected Secret must have restrictive mode' unless secret_volume.dig('secret', 'defaultMode') == 288
private_volume = pod.fetch('volumes').find { |volume| volume['name'] == 'model-gateway-tokens-private' } or abort 'private memory volume missing'
abort 'private token copy must use memory-backed emptyDir' unless private_volume.dig('emptyDir', 'medium') == 'Memory'
signing_volume = pod.fetch('volumes').find { |volume| volume['name'] == 'delegated-signing-key-projected' } or abort 'delegated signing Secret missing'
abort 'delegated signing key must use restrictive projected mode' unless signing_volume.dig('secret', 'defaultMode') == 288
abort 'delegated key projection must not include unrelated fields' unless signing_volume.dig('secret', 'items') == [{'key' => 'private-key.pem', 'path' => 'private-key.pem'}]
container = pod.fetch('containers').find { |item| item['name'] == 'bff' }
env_value = container.fetch('env').find { |item| item['name'] == 'BFF_MODEL_GATEWAY_TOKENS_FILE' }&.fetch('value')
abort 'BFF token map path must point at the private copy' unless env_value == '/private-model-gateway/gateway-tokens.json'
mount = container.fetch('volumeMounts').find { |item| item['name'] == 'model-gateway-tokens-private' }
abort 'private token volume must be mounted read-only' unless mount && mount['readOnly'] == true
delegation_file = container.fetch('env').find { |item| item['name'] == 'BFF_DELEGATED_KEY_FILE' }&.fetch('value')
abort 'BFF delegated key path must point at the private copy' unless delegation_file == '/private-model-gateway/private-key.pem'
kid_ref = container.fetch('env').find { |item| item['name'] == 'BFF_DELEGATED_KID' }&.dig('valueFrom', 'secretKeyRef')
abort 'BFF key id must come from the dedicated delegation Secret' unless kid_ref == {'name' => 'greenguard-bff-delegation', 'key' => 'kid'}

_, _, status = render.call(['--set', 'modelGatewayTokens.enabled=true', '--set', 'modelGatewayTokens.secretName='])
abort 'enabled token feature accepted a missing Secret name' if status.success?
puts 'PASS: tenant gateway token Secret is copied into a private 0600 memory-backed mount; disabled and invalid configurations fail closed'
