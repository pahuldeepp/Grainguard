#!/usr/bin/env ruby
require 'json'
require 'yaml'
require 'open3'
require 'tempfile'

root = __dir__
chart = File.join(root, 'observability-chart')
names = %w[otel-collector prometheus grafana tempo loki]
digest = "123456789012.dkr.ecr.ca-central-1.amazonaws.com/greenguard/obs@sha256:#{'a' * 64}"

def render(chart, images)
  Tempfile.create(['observability-', '.json']) do |file|
    file.write(JSON.generate({ images: images }))
    file.flush
    return Open3.capture3('helm', 'template', 'observability', chart, '--namespace', 'greenguard', '-f', file.path)
  end
end

rendered, error, status = render(chart, names.to_h { |name| [name, digest] })
abort "observability render failed: #{error}" unless status.success?
objects = YAML.safe_load_stream(rendered).compact
deployments = objects.select { |item| item['kind'] == 'Deployment' }
services = objects.select { |item| item['kind'] == 'Service' }
service_accounts = objects.select { |item| item['kind'] == 'ServiceAccount' }
roles = objects.select { |item| item['kind'] == 'Role' }
role_bindings = objects.select { |item| item['kind'] == 'RoleBinding' }
policies = objects.select { |item| item['kind'] == 'NetworkPolicy' }
abort 'observability deployment coverage drift' unless deployments.map { |item| item.dig('metadata', 'name') }.sort == names.sort
abort 'observability service coverage drift' unless services.map { |item| item.dig('metadata', 'name') }.sort == names.sort
abort 'observability backend policies missing' unless policies.map { |item| item.dig('metadata', 'name') }.sort == %w[greenguard-loki greenguard-otel-collector greenguard-tempo]
collector_policy = policies.find { |item| item.dig('metadata', 'name') == 'greenguard-otel-collector' }
abort 'collector does not accept OTLP/HTTP from application pods' unless collector_policy.dig('spec', 'ingress').any? { |rule| rule.fetch('ports').any? { |port| port['port'] == 4318 } && rule.fetch('from').any? { |source| source['podSelector'] == {} } }
abort 'observability ConfigMap missing' unless objects.any? { |item| item['kind'] == 'ConfigMap' && item.dig('metadata', 'name') == 'greenguard-observability-config' }
config = objects.find { |item| item['kind'] == 'ConfigMap' && item.dig('metadata', 'name') == 'greenguard-observability-config' }.fetch('data')
collector_config = YAML.safe_load(config.fetch('otel.yaml'))
abort 'OTLP/HTTP receiver or trace pipeline missing' unless
  collector_config.dig('receivers', 'otlp', 'protocols', 'http', 'endpoint') == '0.0.0.0:4318' &&
  collector_config.dig('service', 'pipelines', 'traces', 'exporters') == ['otlp/tempo']
prometheus_config = YAML.safe_load(config.fetch('prometheus.yaml'))
pod_job = prometheus_config.fetch('scrape_configs').find { |job| job['job_name'] == 'greenguard-istio-pods' }
abort 'Prometheus pod discovery is not limited to the application namespace' unless pod_job.dig('kubernetes_sd_configs', 0, 'namespaces', 'names') == ['greenguard']
relabels = pod_job.fetch('relabel_configs')
abort 'Prometheus must only scrape opt-in pod sidecars' unless relabels.any? { |rule| rule['source_labels'] == ['__meta_kubernetes_pod_annotation_prometheus_io_scrape'] && rule['action'] == 'keep' && rule['regex'] == 'true' } &&
  relabels.any? { |rule| rule['source_labels'] == ['__meta_kubernetes_pod_container_port_number'] && rule['regex'] == '15090' } &&
  relabels.any? { |rule| rule['target_label'] == '__address__' && rule['replacement'] == '$1:15020' }
gateway_job = prometheus_config.fetch('scrape_configs').find { |job| job['job_name'] == 'greenguard-gateway-app' }
abort 'gateway application scrape is missing or not namespace-scoped' unless
  gateway_job && gateway_job.dig('kubernetes_sd_configs', 0, 'namespaces', 'names') == ['greenguard']
gateway_relabels = gateway_job.fetch('relabel_configs')
abort 'gateway application scrape must be pod-opt-in and select only its private endpoint annotations' unless
  gateway_relabels.any? { |rule| rule['source_labels'] == ['__meta_kubernetes_pod_annotation_greenguard_io_app_metrics_scrape'] && rule['action'] == 'keep' && rule['regex'] == 'true' } &&
  gateway_relabels.any? { |rule| rule['source_labels'] == ['__meta_kubernetes_pod_container_port_number'] && rule['action'] == 'keep' && rule['regex'] == '9464' } &&
  gateway_relabels.any? { |rule| rule['source_labels'] == ['__meta_kubernetes_pod_ip', '__meta_kubernetes_pod_annotation_greenguard_io_app_metrics_port'] && rule['target_label'] == '__address__' && rule['replacement'] == '$1:$2' } &&
  gateway_relabels.any? { |rule| rule['source_labels'] == ['__meta_kubernetes_pod_annotation_greenguard_io_app_metrics_path'] && rule['target_label'] == '__metrics_path__' && rule['regex'] == '(/metrics)' }
abort 'Prometheus service account or namespace Role missing' unless
  service_accounts.any? { |item| item.dig('metadata', 'name') == 'greenguard-prometheus' } &&
  roles.any? { |item| item.dig('metadata', 'name') == 'greenguard-prometheus-pod-discovery' && item.dig('rules', 0, 'resources') == ['pods'] } &&
  role_bindings.any? { |item| item.dig('roleRef', 'name') == 'greenguard-prometheus-pod-discovery' && item.dig('subjects', 0, 'name') == 'greenguard-prometheus' }
prometheus_pod = deployments.find { |item| item.dig('metadata', 'name') == 'prometheus' }.dig('spec', 'template')
abort 'Prometheus gateway scraping must use its Istio workload identity' unless
  prometheus_pod.dig('metadata', 'labels', 'sidecar.istio.io/inject') == 'true' &&
  prometheus_pod.dig('spec', 'serviceAccountName') == 'greenguard-prometheus'
deployments.each do |deployment|
  pod = deployment.dig('spec', 'template', 'spec')
  container = pod.fetch('containers').fetch(0)
  abort 'mutable image' unless container.fetch('image') == digest
  abort 'missing resource bounds' unless container.dig('resources', 'requests', 'memory') && container.dig('resources', 'limits', 'memory')
  requires_api_token = deployment.dig('metadata', 'name') == 'prometheus'
  abort 'Prometheus pod discovery needs only its dedicated account' if requires_api_token && (pod['serviceAccountName'] != 'greenguard-prometheus' || pod['automountServiceAccountToken'] != true)
  abort 'privileged observability pod' unless pod['automountServiceAccountToken'] == requires_api_token &&
    container.dig('securityContext', 'allowPrivilegeEscalation') == false &&
    container.dig('securityContext', 'readOnlyRootFilesystem') == true
  if deployment.dig('metadata', 'name') == 'grafana'
    abort 'Grafana must use a Secret for admin credentials' unless container.dig('envFrom', 0, 'secretRef', 'name') == 'grafana-admin'
  end
end
gateway_chart = File.expand_path('../../helm/greenguard-service', root)
gateway_values = File.join(gateway_chart, 'values/gateway.yaml')
gateway_image = "registry.test/greenguard/gateway@sha256:#{'b' * 64}"
gateway_render, gateway_error, gateway_status = Open3.capture3(
  'helm', 'template', 'gateway', gateway_chart, '--namespace', 'greenguard',
  '--values', gateway_values, '--set-string', "image=#{gateway_image}"
)
abort "gateway chart render failed: #{gateway_error}" unless gateway_status.success?
gateway_objects = YAML.safe_load_stream(gateway_render).compact
gateway_deployment = gateway_objects.find do |item|
  item['kind'] == 'Deployment' && item.dig('metadata', 'name') == 'gateway'
end
metrics_host = gateway_deployment&.dig('spec', 'template', 'spec', 'containers', 0, 'env')&.find do |item|
  item['name'] == 'GATEWAY_METRICS_HOST'
end
abort 'gateway pod-IP metrics scraping requires an explicit pod-reachable bind host' unless metrics_host&.fetch('value', nil) == '0.0.0.0'
gateway_policy = gateway_objects.find do |item|
  item['kind'] == 'NetworkPolicy' && item.dig('metadata', 'name') == 'gateway'
end
metrics_rule = gateway_policy&.dig('spec', 'ingress')&.find do |rule|
  rule.fetch('ports', []).any? { |port| port['port'] == 9464 }
end
prometheus_deployment = deployments.find { |item| item.dig('metadata', 'name') == 'prometheus' }
prometheus_labels = prometheus_deployment.dig('spec', 'template', 'metadata', 'labels')
metrics_source = metrics_rule&.dig('from')&.find do |source|
  source.dig('namespaceSelector', 'matchLabels', 'kubernetes.io/metadata.name') == 'greenguard'
end
metrics_selector = metrics_source&.dig('podSelector', 'matchLabels')
abort 'gateway metrics NetworkPolicy selector must match the rendered Prometheus pod labels' unless
  metrics_selector && !metrics_selector.empty? && metrics_selector.all? { |key, value| prometheus_labels[key] == value }
abort 'gateway metrics scrape principal must match the rendered Prometheus service account' unless
  prometheus_deployment.dig('spec', 'template', 'spec', 'serviceAccountName') == 'greenguard-prometheus' &&
  gateway_objects.any? do |item|
    item['kind'] == 'AuthorizationPolicy' && item.dig('metadata', 'name') == 'gateway-app-metrics' &&
      item.dig('spec', 'rules', 0, 'from', 0, 'source', 'notPrincipals') == ['cluster.local/ns/greenguard/sa/greenguard-prometheus']
  end
abort 'public observability Service' unless services.all? { |service| service.dig('spec', 'type') == 'ClusterIP' }
abort 'mutable tag accepted' if render(chart, names.to_h { |name| [name, 'repo/obs:latest'] }).fetch(2).success?
abort 'missing digest accepted' if render(chart, names.drop(1).to_h { |name| [name, digest] }).fetch(2).success?
terraform = File.read(File.join(root, '../../terraform/disposable/gitops.tf'))
abort 'disposable release OTLP/HTTP wiring missing' unless terraform.match?(/otel_http_releases\s*=\s*toset\(\[/) &&
  terraform.match?(/name\s*=\s*"OTEL_EXPORTER_OTLP_ENDPOINT"/) &&
  terraform.include?('http://otel-collector.greenguard.svc.cluster.local:4318') &&
  terraform.match?(/enabled\s*=\s*contains\(local\.otel_http_releases, release\.name\)/) &&
  terraform.match?(/otlpPort\s*=\s*4318/) &&
  terraform.match?(/prometheus\s*=\s*\{\s*enabled\s*=\s*true/m)
puts 'Disposable observability chart renders five digest-only private components, scoped scrape discovery, and OTLP/HTTP release wiring.'
