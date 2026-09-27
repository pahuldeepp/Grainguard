#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
ruby infra/gitops/disposable/render-target-group-bindings.rb \
  infra/gitops/disposable/target-groups.example.json > "$rendered"
ruby - "$rendered" <<'RUBY'
require 'yaml'
objects = YAML.load_stream(File.read(ARGV.fetch(0))).compact
abort 'expected one IP TargetGroupBinding' unless objects.length == 1 && objects.first['kind'] == 'TargetGroupBinding' && objects.first.dig('spec', 'targetType') == 'ip'
binding = objects.first
abort 'ingress Service reference drifted' unless binding.dig('metadata', 'namespace') == 'istio-system' && binding.dig('spec', 'serviceRef') == { 'name' => 'istio-ingressgateway', 'port' => 80 }
abort 'controller must not manage security groups' if binding.dig('spec', 'networking')
RUBY
if ruby infra/gitops/disposable/render-target-group-bindings.rb /dev/null > /dev/null 2>&1; then
  echo 'invalid target group data was accepted' >&2
  exit 1
fi
ruby -rjson -e 'v=JSON.parse(File.read(ARGV[0])); v["namespace"]="greenguard"; File.write(ARGV[1], JSON.generate(v))' \
  infra/gitops/disposable/target-groups.example.json "$rendered"
if ruby infra/gitops/disposable/render-target-group-bindings.rb "$rendered" > /dev/null 2>&1; then
  echo 'application namespace target binding was accepted' >&2
  exit 1
fi
image="example.com/greenguard@sha256:$(printf '%064d' 0)"
for name in dashboard bff; do
  helm template "$name" "infra/helm/greenguard-$name" --namespace greenguard \
    --set-string "image=$image" > "$rendered"
  ruby - "$rendered" "$name" <<'RUBY'
require 'yaml'
objects = YAML.load_stream(File.read(ARGV.fetch(0))).compact
release = ARGV.fetch(1)
service = objects.find { |o| o['kind'] == 'Service' }
policy = objects.find { |o| o['kind'] == 'NetworkPolicy' }
expected = "#{release}-greenguard-#{release}"
abort 'Service name drifted' unless service.dig('metadata', 'name') == expected
abort 'Istio ingress pod selector missing' unless policy.dig('spec', 'ingress').any? { |i| i.fetch('from', []).any? { |from| from.dig('namespaceSelector', 'matchLabels', 'kubernetes.io/metadata.name') == 'istio-system' && from.dig('podSelector', 'matchLabels', 'app') == 'istio-ingressgateway' } }
RUBY
done
ruby <<'RUBY'
require 'yaml'
objects = YAML.load_stream(File.read('infra/gitops/disposable/mesh-edge-routing.yaml')).compact
abort 'missing Istio routes' unless objects.map { |o| o['kind'] }.sort == %w[DestinationRule DestinationRule Gateway VirtualService]
gateway = objects.find { |o| o['kind'] == 'Gateway' }
virtual = objects.find { |o| o['kind'] == 'VirtualService' }
abort 'wrong ingress selector' unless gateway.dig('metadata', 'namespace') == 'istio-system' && gateway.dig('spec', 'selector', 'app') == 'istio-ingressgateway'
abort 'wrong gateway binding' unless virtual.dig('metadata', 'namespace') == 'greenguard' && virtual.dig('spec', 'gateways') == ['istio-system/greenguard-edge']
routes = virtual.dig('spec', 'http')
%w[bff dashboard].each_with_index do |name, index|
  route = routes.fetch(index)
  abort "#{name} header route drifted" unless route['name'] == name && route.dig('match', 0, 'headers', 'x-greenguard-origin', 'exact') == name
  expected = "#{name}-greenguard-#{name}.greenguard.svc.cluster.local"
  abort "#{name} destination drifted" unless route.dig('route', 0, 'destination', 'host') == expected && route.dig('route', 0, 'destination', 'port', 'number') == 80
end
abort 'unknown origin must fail closed' unless routes.fetch(2).dig('directResponse', 'status') == 404
abort 'destinations must use mTLS' unless objects.select { |o| o['kind'] == 'DestinationRule' }.all? { |o| o.dig('spec', 'trafficPolicy', 'tls', 'mode') == 'ISTIO_MUTUAL' }
RUBY
echo 'TargetGroupBinding and Istio edge routing contract passed.'
