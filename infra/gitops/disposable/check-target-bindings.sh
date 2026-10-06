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
helm template edge infra/gitops/disposable/edge-routing-chart --set-string cell=gg-disposable-test --set-string accountId=123456789012 --set-string region=us-east-1 --set-string targetGroupARN=arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/gg-test/0123456789abcdef > "$rendered"
ruby - "$rendered" <<'RUBY'
require 'yaml'
objects = YAML.load_stream(File.read(ARGV.fetch(0))).compact
abort 'missing deployable edge resources' unless objects.map { |o| o['kind'] }.sort == %w[DestinationRule DestinationRule DestinationRule DestinationRule Gateway TargetGroupBinding VirtualService]
binding = objects.find { |o| o['kind'] == 'TargetGroupBinding' }
abort 'wrong target binding' unless binding.dig('spec', 'serviceRef') == {'name'=>'istio-ingressgateway', 'port'=>80} && binding.dig('spec', 'targetType') == 'ip'
abort 'unexpected security group management' if binding.dig('spec', 'networking')
abort 'cell ownership missing' unless objects.all? { |o| o.dig('metadata', 'labels', 'greenguard.io/cell') == 'gg-disposable-test' }
gateway = objects.find { |o| o['kind'] == 'Gateway' }
virtual = objects.find { |o| o['kind'] == 'VirtualService' }
abort 'wrong ingress selector' unless gateway.dig('spec', 'selector', 'app') == 'istio-ingressgateway'
abort 'wrong gateway binding' unless virtual.dig('spec', 'gateways') == ['istio-system/greenguard-edge']
routes = virtual.dig('spec', 'http')
webhook = routes.fetch(0)
abort 'webhook routing drifted' unless webhook['name'] == 'stripe-webhook' && webhook.dig('match',0,'uri','exact') == '/webhooks/stripe' && webhook.dig('match',0,'headers','x-greenguard-origin','exact') == 'bff' && webhook.dig('route',0,'destination','host') == 'billing-service.greenguard.svc.cluster.local' && webhook.dig('route',0,'destination','port','number') == 3021
%w[bff dashboard].each_with_index do |name,index|
  route = routes.fetch(index+1)
  abort "#{name} header route drifted" unless route['name'] == name && route.dig('match',0,'headers','x-greenguard-origin','exact') == name
  abort "#{name} destination drifted" unless route.dig('route',0,'destination','host') == "#{name}-greenguard-#{name}.greenguard.svc.cluster.local" && route.dig('route',0,'destination','port','number') == 80
end
abort 'unknown origin must fail closed' unless routes.fetch(3).dig('directResponse','status') == 404
abort 'destinations must use mTLS' unless objects.select { |o| o['kind'] == 'DestinationRule' }.all? { |o| o.dig('spec','trafficPolicy','tls','mode') == 'ISTIO_MUTUAL' }
RUBY
for arn in arn:aws:elasticloadbalancing:us-east-1:999999999999:targetgroup/gg-test/0123456789abcdef arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/gg-test/0123456789abcdef; do
  if helm template edge infra/gitops/disposable/edge-routing-chart --set-string cell=gg-disposable-test --set-string accountId=123456789012 --set-string region=us-east-1 --set-string "targetGroupARN=$arn" > /dev/null 2>&1; then
    echo 'cross-account or cross-region target group accepted' >&2
    exit 1
  fi
done
echo 'TargetGroupBinding and deployed Istio edge routing contract passed.'
