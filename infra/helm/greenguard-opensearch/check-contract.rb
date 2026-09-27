#!/usr/bin/env ruby
require 'open3'
require 'yaml'

chart = __dir__
digest = 'a' * 64
image = "opensearchproject/opensearch@sha256:#{digest}"
bootstrap_image = "example/search-indexer@sha256:#{'b' * 64}"
base = ['helm', 'template', 'greenguard-opensearch', chart, '--namespace', 'greenguard', '--set', "image=#{image}", '--set', "bootstrap.image=#{bootstrap_image}"]
output, error, status = Open3.capture3(*base)
abort "OpenSearch chart render failed: #{error}" unless status.success?
objects = YAML.safe_load_stream(output).compact
kind = ->(name) { objects.find { |object| object['kind'] == name } }
statefulset = kind.call('StatefulSet') or abort 'OpenSearch StatefulSet missing'
pod = statefulset.dig('spec', 'template', 'spec')
container = pod.fetch('containers').find { |item| item['name'] == 'opensearch' } or abort 'OpenSearch container missing'
abort 'unlocked image' unless container['image'] == image
abort 'non-root security missing' unless pod.dig('securityContext', 'runAsNonRoot') == true && pod.dig('securityContext', 'runAsUser') == 1000
abort 'admin secret missing' unless container.fetch('env').any? { |item| item['name'] == 'OPENSEARCH_ADMIN_PASSWORD' && item.dig('valueFrom', 'secretKeyRef', 'name') == 'greenguard-opensearch-admin' && item.dig('valueFrom', 'secretKeyRef', 'key') == 'password' }
abort 'demo security setup not disabled' unless container.fetch('env').any? { |item| item['name'] == 'DISABLE_INSTALL_DEMO_CONFIG' && item['value'] == 'true' }
config_mount = container.fetch('volumeMounts').find { |mount| mount['mountPath'] == '/usr/share/opensearch/config/opensearch.yml' }
abort 'OpenSearch entrypoint config mount must be writable' unless config_mount && config_mount['readOnly'] != true
tls_volume = pod.fetch('volumes').find { |volume| volume['name'] == 'tls-node' }
abort 'custom server certificate Secret missing' unless tls_volume.dig('secret', 'secretName') == 'greenguard-opensearch-tls'
abort 'admin key must not mount into OpenSearch server' if tls_volume.dig('secret', 'items').any? { |item| item['key'] == 'admin.key' }
init_script = pod.dig('initContainers', 0, 'args', 0)
abort 'certificate SAN/chain/key validation missing' unless init_script.include?('openssl x509 -in /tls/node.crt -noout -checkend 86400') && init_script.include?('openssl verify -purpose sslserver -verify_hostname greenguard-opensearch.greenguard.svc.cluster.local -CAfile /ca/ca.crt') && init_script.include?('plugins.security.ssl.http.pemcert_filepath: certs/node.crt')
abort 'TLS verifier image drifted' unless pod.dig('initContainers', 0, 'image') == bootstrap_image
readiness = container.dig('readinessProbe', 'exec', 'command').join(' ')
abort 'readiness must authenticate and verify service hostname over HTTPS without a readiness deadlock' unless readiness.include?('--resolve greenguard-opensearch.greenguard.svc.cluster.local:9200:127.0.0.1') && readiness.include?('--cacert /etc/opensearch-ca/ca.crt') && readiness.include?('https://greenguard-opensearch.greenguard.svc.cluster.local:9200/_cluster/health') && !readiness.include?('--insecure')
abort 'security-init cannot connect before readiness' unless kind.call('Service').dig('spec', 'publishNotReadyAddresses') == true
abort 'bounded disk missing' unless statefulset.dig('spec', 'volumeClaimTemplates', 0, 'spec', 'resources', 'requests', 'storage') == '20Gi'
abort 'wrong disk class' unless statefulset.dig('spec', 'volumeClaimTemplates', 0, 'spec', 'storageClassName') == 'gp3'
abort 'STRICT mTLS missing' unless kind.call('PeerAuthentication').dig('spec', 'mtls', 'mode') == 'STRICT'
policy = kind.call('NetworkPolicy') or abort 'NetworkPolicy missing'
abort 'missing ingress/egress boundary' unless policy.dig('spec', 'policyTypes').sort == %w[Egress Ingress]
clients = policy.dig('spec', 'ingress', 0, 'from').map { |source| source.dig('podSelector', 'matchLabels', 'app.kubernetes.io/name') || source.dig('podSelector', 'matchLabels', 'app') }
abort 'unexpected ingress clients' unless clients.sort == %w[greenguard-opensearch-security-init read-api search-indexer]
principals = kind.call('AuthorizationPolicy').dig('spec', 'rules', 0, 'from', 0, 'source', 'principals')
abort 'wrong mesh principals' unless principals.sort == %w[cluster.local/ns/greenguard/sa/read-api cluster.local/ns/greenguard/sa/search-indexer]
security_job = objects.find { |object| object['kind'] == 'Job' && object.dig('metadata', 'name') == 'greenguard-opensearch-security-init' } or abort 'security init Job missing'
abort 'security init lacks deadline' unless security_job.dig('spec', 'activeDeadlineSeconds') == 600
script = kind.call('ConfigMap').dig('data', 'security-init.sh')
abort 'least privilege roles missing' unless script.include?("index_patterns: ['greenguard-inventory-v*']") && script.include?("allowed_actions: ['read', 'index', 'create_index']") && script.include?("allowed_actions: ['read']") && script.include?('securityadmin.sh')
[
  ['--set', 'image=opensearchproject/opensearch:3.8.0'],
  ['--set', 'mesh.strictMtls=false'],
  ['--set', 'storageSize=101Gi'],
  ['--set', 'adminSecretName=other'],
  ['--set', 'tlsSecretName=other'],
].each do |override|
  _, _, result = Open3.capture3(*base, *override)
  abort "unsafe OpenSearch values were accepted: #{override.join(' ')}" if result.success?
end
_, _, without_digest = Open3.capture3(*base.take(6))
abort 'OpenSearch without image digest rendered' if without_digest.success?
bootstrap_output, bootstrap_error, bootstrap_status = Open3.capture3(*base, '--set', 'bootstrap.enabled=true')
abort "OpenSearch bootstrap render failed: #{bootstrap_error}" unless bootstrap_status.success?
bootstrap_objects = YAML.safe_load_stream(bootstrap_output).compact
job = bootstrap_objects.find { |object| object['kind'] == 'Job' } or abort 'OpenSearch bootstrap Job missing'
job_container = job.dig('spec', 'template', 'spec', 'containers', 0)
abort 'bootstrap image or command mismatch' unless job_container['image'] == bootstrap_image && job_container.dig('args', 0).include?('python /app/search_indexer.py bootstrap --version 1') && job_container.dig('args', 0).include?('quitquitquit')
abort 'bootstrap lacks bounded retry/deadline' unless job.dig('spec', 'backoffLimit') == 6 && job.dig('spec', 'activeDeadlineSeconds') == 600
abort 'bootstrap CA secret missing' unless job.dig('spec', 'template', 'spec', 'volumes', 0, 'secret', 'secretName') == 'greenguard-opensearch-ca'
_, _, unsafe_bootstrap = Open3.capture3(*base, '--set', 'bootstrap.image=example/search-indexer:latest')
abort 'bootstrap without digest rendered' if unsafe_bootstrap.success?
puts 'OpenSearch disposable chart: digest, secret, non-root, bounded disk, authenticated readiness, mTLS, ingress and bootstrap checks pass; unsafe renders rejected'
