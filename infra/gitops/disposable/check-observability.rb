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
objects = YAML.load_stream(rendered).compact
deployments = objects.select { |item| item['kind'] == 'Deployment' }
services = objects.select { |item| item['kind'] == 'Service' }
claims = objects.select { |item| item['kind'] == 'PersistentVolumeClaim' }
service_accounts = objects.select { |item| item['kind'] == 'ServiceAccount' }
roles = objects.select { |item| item['kind'] == 'Role' }
role_bindings = objects.select { |item| item['kind'] == 'RoleBinding' }
policies = objects.select { |item| item['kind'] == 'NetworkPolicy' }
abort 'observability deployment coverage drift' unless deployments.map { |item| item.dig('metadata', 'name') }.sort == names.sort
abort 'observability service coverage drift' unless services.map { |item| item.dig('metadata', 'name') }.sort == names.sort
claim = claims.find { |item| item.dig('metadata', 'name') == 'prometheus-data' }
abort 'Prometheus must retain SLO history on the encrypted disposable gp3 claim' unless
  claims.length == 1 &&
  claim&.dig('spec', 'storageClassName') == 'greenguard-disposable-gp3' &&
  claim&.dig('spec', 'resources', 'requests', 'storage') == '30Gi'
abort 'observability backend policies missing' unless policies.map { |item| item.dig('metadata', 'name') }.sort == %w[greenguard-loki greenguard-otel-collector greenguard-tempo]
collector_policy = policies.find { |item| item.dig('metadata', 'name') == 'greenguard-otel-collector' }
abort 'collector does not accept OTLP/HTTP from application pods' unless collector_policy.dig('spec', 'ingress').any? { |rule| rule.fetch('ports').any? { |port| port['port'] == 4318 } && rule.fetch('from').any? { |source| source['podSelector'] == {} } }
abort 'observability ConfigMap missing' unless objects.any? { |item| item['kind'] == 'ConfigMap' && item.dig('metadata', 'name') == 'greenguard-observability-config' }
config = objects.find { |item| item['kind'] == 'ConfigMap' && item.dig('metadata', 'name') == 'greenguard-observability-config' }.fetch('data')
abort 'disposable SLO rules drifted from the validated shared SLO rules' unless
  config.fetch('slo-rules.yaml') == File.read(File.join(__dir__, '../../observability/rules/slo.yaml'))
slo_groups = YAML.safe_load(config.fetch('slo-rules.yaml')).fetch('groups')
abort 'Prometheus SLO rules must include the 30-day rolling error-budget recording rule' unless
  slo_groups.flat_map { |group| group.fetch('rules') }.any? { |rule| rule['record'] == 'slo:error_budget_remaining:ratio30d' }
collector_config = YAML.safe_load(config.fetch('otel.yaml'))
abort 'OTLP/HTTP receiver or trace pipeline missing' unless
  collector_config.dig('receivers', 'otlp', 'protocols', 'http', 'endpoint') == '0.0.0.0:4318' &&
  collector_config.dig('service', 'pipelines', 'traces', 'exporters') == ['otlp/tempo']
prometheus_config = YAML.safe_load(config.fetch('prometheus.yaml'))
scrapes = prometheus_config.fetch('scrape_configs')
job_names = scrapes.map { |job| job['job_name'] }
abort 'Prometheus scrape job names must be present and unique' unless
  job_names.none?(&:nil?) && job_names.uniq.length == job_names.length
merged_job = scrapes.find { |job| job['job_name'] == 'greenguard-istio-merged-pods' }
proxy_job = scrapes.find { |job| job['job_name'] == 'greenguard-istio-proxy-pods' }
abort 'Prometheus merged and Envoy-only discovery jobs must be namespace-scoped' unless
  [merged_job, proxy_job].all? { |job| job && job.dig('kubernetes_sd_configs', 0, 'namespaces', 'names') == ['greenguard'] }
[[merged_job, '(true|)', '$1:15020'], [proxy_job, 'false', '$1:15090']].each do |job, merge_value, address|
  relabels = job.fetch('relabel_configs')
  abort 'Prometheus must only scrape opt-in running sidecars on the declared proxy metrics port' unless
    relabels.any? { |rule| rule['source_labels'] == ['__meta_kubernetes_pod_annotation_prometheus_io_scrape'] && rule['action'] == 'keep' && rule['regex'] == 'true' } &&
    relabels.any? { |rule| rule['source_labels'] == ['__meta_kubernetes_pod_phase'] && rule['regex'] == 'Running' } &&
    relabels.any? { |rule| rule['source_labels'] == ['__meta_kubernetes_pod_container_port_number'] && rule['regex'] == '15090' } &&
    relabels.any? { |rule| rule['source_labels'] == ['__meta_kubernetes_pod_annotation_prometheus_istio_io_merge_metrics'] && rule['action'] == 'keep' && rule['regex'] == merge_value } &&
    relabels.any? { |rule| rule['target_label'] == '__address__' && rule['replacement'] == address } &&
    relabels.any? { |rule| rule['source_labels'] == ['__meta_kubernetes_pod_label_app_kubernetes_io_instance'] && rule['target_label'] == 'job' }
end
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
prometheus_container = prometheus_pod.dig('spec', 'containers', 0)
abort 'Prometheus retention must exceed the 30-day SLO window and be disk bounded' unless
  prometheus_container.fetch('args').include?('--storage.tsdb.retention.time=35d') &&
  prometheus_container.fetch('args').include?('--storage.tsdb.retention.size=24GB')
abort 'Prometheus TSDB must use the owned persistent claim' unless
  prometheus_pod.dig('spec', 'volumes').any? { |volume| volume.dig('persistentVolumeClaim', 'claimName') == 'prometheus-data' } &&
  prometheus_container.fetch('volumeMounts').any? { |mount| mount['name'] == 'data' && mount['mountPath'] == '/prometheus' }
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
gateway_objects = YAML.load_stream(gateway_render).compact
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
expected_metric_releases = %w[device-service workflow-alerts telemetry-ingest projection-builder notification-service jobs-worker cdc-transformer cassandra-writer]
expected_metric_releases.each do |release|
  service_values = File.join(gateway_chart, "values/#{release}.yaml")
  profile = YAML.safe_load(File.read(service_values))
  service_port = profile.dig('service', 'containerPort')
  abort "#{release} profile has no app metrics port" unless service_port
  service_image = "registry.test/greenguard/#{release}@sha256:#{'d' * 64}"
  service_render, service_error, service_status = Open3.capture3(
    'helm', 'template', release, gateway_chart, '--namespace', 'greenguard',
    '--values', service_values, '--set-string', "image=#{service_image}",
    '--set', 'mesh.enabled=true', '--set', 'mesh.strictMtls=true',
    '--set', 'observability.prometheus.enabled=true', '--set', 'observability.prometheus.mergeMetrics=true',
    '--set', 'observability.prometheus.scrapePort=15020'
  )
  abort "#{release} merged-metrics chart render failed: #{service_error}" unless service_status.success?
  service_objects = YAML.load_stream(service_render).compact
  service_pod = service_objects.find { |item| item['kind'] == 'Deployment' }.dig('spec', 'template', 'metadata')
  abort "#{release} merged-metrics annotations must point Istio at its app /metrics endpoint" unless
    service_pod.dig('annotations', 'prometheus.io/scrape') == 'true' &&
    service_pod.dig('annotations', 'prometheus.io/path') == '/metrics' &&
    service_pod.dig('annotations', 'prometheus.io/port') == service_port.to_s &&
    service_pod.dig('annotations', 'prometheus.istio.io/merge-metrics') == 'true'
end
service_values = File.join(gateway_chart, 'values/telemetry-ingest.yaml')
service_image = "registry.test/greenguard/telemetry-ingest@sha256:#{'d' * 64}"
proxy_render, proxy_error, proxy_status = Open3.capture3(
  'helm', 'template', 'telemetry-ingest', gateway_chart, '--namespace', 'greenguard',
  '--values', service_values, '--set-string', "image=#{service_image}",
  '--set', 'mesh.enabled=true', '--set', 'mesh.strictMtls=true',
  '--set', 'observability.prometheus.enabled=true', '--set', 'observability.prometheus.mergeMetrics=false',
  '--set', 'observability.prometheus.scrapePort=15090'
)
abort "telemetry-ingest Envoy-only chart render failed: #{proxy_error}" unless proxy_status.success?
proxy_objects = YAML.load_stream(proxy_render).compact
proxy_pod = proxy_objects.find { |item| item['kind'] == 'Deployment' }.dig('spec', 'template', 'metadata')
abort 'Envoy-only annotations must not claim an application metrics endpoint' unless
  proxy_pod.dig('annotations', 'prometheus.io/path') == '/stats/prometheus' &&
  proxy_pod.dig('annotations', 'prometheus.io/port') == '15090' &&
  proxy_pod.dig('annotations', 'prometheus.istio.io/merge-metrics') == 'false'
abort 'public observability Service' unless services.all? { |service| service.dig('spec', 'type') == 'ClusterIP' }
abort 'mutable tag accepted' if render(chart, names.to_h { |name| [name, 'repo/obs:latest'] }).fetch(2).success?
abort 'missing digest accepted' if render(chart, names.drop(1).to_h { |name| [name, digest] }).fetch(2).success?
terraform = File.read(File.join(root, '../../terraform/disposable/gitops.tf'))
metric_release_block = terraform[/prometheus_application_metric_releases\s*=\s*toset\(\[(.*?)\]\)/m, 1]
abort 'SLO-producing applications must use merged application metrics' unless
  metric_release_block && expected_metric_releases.all? { |release| metric_release_block.include?("\"#{release}\"") } &&
  terraform.match?(/mergeMetrics\s*=\s*contains\(local\.prometheus_application_metric_releases, release\.name\)/) &&
  terraform.match?(/scrapePort\s*=\s*contains\(local\.prometheus_application_metric_releases, release\.name\) \? 15020 : 15090/)
abort 'disposable release OTLP/HTTP wiring missing' unless terraform.match?(/otel_http_releases\s*=\s*toset\(\[/) &&
  terraform.match?(/name\s*=\s*"OTEL_EXPORTER_OTLP_ENDPOINT"/) &&
  terraform.include?('http://otel-collector.greenguard.svc.cluster.local:4318') &&
  terraform.match?(/enabled\s*=\s*contains\(local\.otel_http_releases, release\.name\)/) &&
  terraform.match?(/otlpPort\s*=\s*4318/) &&
  terraform.match?(/prometheus\s*=\s*\{\s*enabled\s*=\s*true/m)
puts 'Disposable observability chart renders five digest-only private components, persistent 30-day SLO history, distinct merged/proxy scrape discovery, app-metrics endpoints, and OTLP/HTTP release wiring.'
