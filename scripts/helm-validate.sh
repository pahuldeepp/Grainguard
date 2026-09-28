#!/usr/bin/env bash
set -euo pipefail

chart="infra/helm/greenguard-dashboard"
bff_chart="infra/helm/greenguard-bff"
service_chart="infra/helm/greenguard-service"
image="ghcr.io/pahuldeepp/grainguard/dashboard@sha256:$(printf '%064d' 0)"
bff_image="ghcr.io/pahuldeepp/grainguard/bff@sha256:$(printf '%064d' 0)"
service_image="ghcr.io/pahuldeepp/grainguard/service@sha256:$(printf '%064d' 0)"
rendered="$(mktemp)"
mesh_rendered="$(mktemp)"
bff_rendered="$(mktemp)"
rollout_rendered="$(mktemp)"
trap 'rm -f "$rendered" "$mesh_rendered" "$bff_rendered" "$rollout_rendered"' EXIT

# Parse individual YAML objects so a field on an unrelated resource cannot satisfy
# a scheduling/scaling assertion. Ruby/Psych are already used by local gates.
assert_runtime_profile() {
  ruby - "$rendered" "$@" <<'RUBY'
require 'yaml'
path, profile, mode, minimum, maximum, grace, scheduling, pdb_disabled = ARGV
objects = YAML.load_stream(File.read(path)).compact
check = ->(ok, message) { abort "#{profile}: #{message}" unless ok }
find = ->(kind) { objects.select { |object| object['kind'] == kind } }
check.call(find.call('Deployment').length == 1, 'expected one Deployment')
deployment = find.call('Deployment').first
spec = deployment.fetch('spec')
pod = spec.fetch('template').fetch('spec')
hpas = find.call('HorizontalPodAutoscaler')
kedas = find.call('ScaledObject')
check.call(pod['terminationGracePeriodSeconds'] == grace.to_i, 'shutdown grace drifted')
if mode == 'fixed'
  check.call(hpas.empty? && kedas.empty?, 'fixed replicas must have no autoscaler')
  check.call(spec['replicas'] == minimum.to_i, 'fixed replica count drifted')
else
  owners, others, min_key, max_key = mode == 'hpa' ? [hpas, kedas, 'minReplicas', 'maxReplicas'] : [kedas, hpas, 'minReplicaCount', 'maxReplicaCount']
  check.call(owners.length == 1 && others.empty? && !spec.key?('replicas'), 'autoscaler must exclusively own replicas')
  scaling = owners.first.fetch('spec')
  check.call(scaling[min_key] == minimum.to_i && scaling[max_key] == maximum.to_i, 'autoscaling min/max drifted')
  check.call(scaling[min_key] >= (mode == 'hpa' ? 1 : 0) && scaling[min_key] < scaling[max_key], 'unsafe autoscaling bounds')
  target = scaling.fetch('scaleTargetRef')
  check.call(target['name'] == deployment.dig('metadata', 'name'), 'autoscaler target name drifted')
  # KEDA's omitted apiVersion/kind use apps/v1 and Deployment defaults:
  # https://keda.sh/docs/2.21/reference/scaledobject-spec/
  target_version = mode == 'keda' ? target.fetch('apiVersion', 'apps/v1') : target['apiVersion']
  target_kind = mode == 'keda' ? target.fetch('kind', 'Deployment') : target['kind']
  check.call(target_version == 'apps/v1' && target_kind == 'Deployment', 'autoscaler target kind/version drifted')
  if mode == 'hpa'
    check.call(owners.first['apiVersion'] == 'autoscaling/v2', 'HPA must use autoscaling/v2')
    cpu = scaling.fetch('metrics', []).first || {}
    check.call(cpu['type'] == 'Resource' && cpu.dig('resource', 'name') == 'cpu' && cpu.dig('resource', 'target', 'type') == 'Utilization' && cpu.dig('resource', 'target', 'averageUtilization') == 70, 'HPA CPU Resource/Utilization metric drifted')
    check.call(scaling.dig('behavior', 'scaleDown', 'stabilizationWindowSeconds') == 300, 'HPA stabilization drifted')
  else
    check.call(!scaling.fetch('triggers', []).empty?, 'KEDA needs a trigger')
    check.call(scaling['pollingInterval'] == 30 && scaling['cooldownPeriod'] == 300, 'KEDA polling/cooldown drifted')
  end
end
pdbs = find.call('PodDisruptionBudget')
pdbs.each do |pdb|
  check.call(pdb.dig('spec', 'minAvailable') < minimum.to_i, 'PDB blocks disruption at minimum replicas')
  check.call(pdb.dig('spec', 'selector', 'matchLabels') == spec.dig('selector', 'matchLabels'), 'PDB selector drifted')
end
worker = %w[hardware-service-worker eventbridge-bridge saga-worker].include?(profile)
expected_pdb = pdb_disabled == 'no-pdb' ? pdbs.empty? : (worker ? pdbs.empty? || minimum.to_i >= 2 : pdbs.length == 1)
check.call(expected_pdb, 'PDB ownership drifted')
if worker
  check.call(pod.dig('nodeSelector', 'greenguard.io/workload-class') == 'compute', 'worker must select compute nodes')
  check.call(pod.fetch('tolerations', []).any? { |t| t['key'] == 'greenguard.io/workload-class' && t['operator'] == 'Equal' && t['value'] == 'compute' && t['effect'] == 'NoSchedule' }, 'worker must tolerate the compute NoSchedule taint')
end
if scheduling == 'spread'
  check.call(pod['priorityClassName'] == 'greenguard-compute', 'configured priority class drifted')
  spread = pod.fetch('topologySpreadConstraints', [])
  check.call(spread.length == 1, 'expected one configured spread constraint')
  check.call(spread.first['maxSkew'] == 1 && spread.first['topologyKey'] == 'topology.kubernetes.io/zone' && spread.first['whenUnsatisfiable'] == 'DoNotSchedule', 'zone spread fields drifted')
  check.call(spread.first.dig('labelSelector', 'matchLabels') == spec.dig('selector', 'matchLabels'), 'spread selector must match this Deployment')
else
  check.call(!pod.key?('priorityClassName') && !pod.key?('topologySpreadConstraints'), 'optional scheduling fields unexpectedly enabled')
end
RUBY
}

# Mutate a valid rendered autoscaler to prove target/metric drift is detected
# even when its target name and replica bounds remain unchanged.
assert_autoscaler_drift_rejected() {
  local mutation="$1"
  shift
  cp "$rendered" "$mesh_rendered"
  ruby - "$rendered" "$mutation" <<'RUBY'
require 'yaml'
path, mutation = ARGV
objects = YAML.load_stream(File.read(path)).compact
owner = objects.find { |object| %w[HorizontalPodAutoscaler ScaledObject].include?(object['kind']) }
spec = owner.fetch('spec')
case mutation
when 'kind' then spec.fetch('scaleTargetRef')['kind'] = 'StatefulSet'
when 'apiVersion' then spec.fetch('scaleTargetRef')['apiVersion'] = 'apps/v2'
when 'metricType' then spec.fetch('metrics').first['type'] = 'External'
when 'metricName' then spec.fetch('metrics').first.fetch('resource')['name'] = 'memory'
when 'metricTarget' then spec.fetch('metrics').first.fetch('resource').fetch('target')['type'] = 'AverageValue'
else abort "unknown autoscaler mutation: #{mutation}"
end
File.write(path, objects.map(&:to_yaml).join)
RUBY
  if assert_runtime_profile "$@" 2>"$bff_rendered"; then
    echo "Autoscaler gate unexpectedly accepted $mutation drift" >&2; exit 1
  fi
  local diagnostic='autoscaler target kind/version drifted'
  case "$mutation" in metric*) diagnostic='HPA CPU Resource/Utilization metric drifted' ;; esac
  if ! grep -Fq "$diagnostic" "$bff_rendered"; then
    echo "$mutation: autoscaler rejection had an unexpected cause" >&2
    cat "$bff_rendered" >&2; exit 1
  fi
  echo "Expected autoscaler rejection: $mutation ($diagnostic)"
  cp "$mesh_rendered" "$rendered"
}

expect_runtime_rejection() {
  local label="$1" diagnostic="$2"
  shift 2
  if helm template "$label" "$service_chart" --set-string "image=$service_image" "$@" >"$rendered" 2>&1; then
    echo "$label: unsafe profile unexpectedly rendered" >&2
    exit 1
  fi
  if ! grep -Fq "$diagnostic" "$rendered"; then
    echo "$label: failed for an unexpected reason (expected $diagnostic)" >&2
    cat "$rendered" >&2
    exit 1
  fi
}

for profile in gateway device-service read-api workflow-alerts telemetry-ingest \
  cdc-transformer projection-builder cache-invalidator risk-engine saga-api; do
  values="$service_chart/values/$profile.yaml"
  helm lint "$service_chart" --values "$values" --set-string "image=$service_image"
  helm template "$profile" "$service_chart" --namespace greenguard \
    --values "$values" --set-string "image=$service_image" >"$rendered"
  expected_name="$profile"
  if [ "$profile" = "saga-api" ]; then expected_name=saga-orchestrator; fi
  if ! grep -Fq "nameOverride: $expected_name" "$values"; then
    echo "Runtime profile does not identify its service: $profile" >&2
    exit 1
  fi
  for expected in \
    'runAsNonRoot: true' \
    'readOnlyRootFilesystem: true' \
    'allowPrivilegeEscalation: false' \
    'kind: NetworkPolicy' \
    'kind: PodDisruptionBudget' \
    'maxUnavailable: 0' \
    'kind: Deployment'; do
    if ! grep -Fq "$expected" "$rendered"; then
      echo "$profile rendered manifest is missing required hardening: $expected" >&2
      exit 1
    fi
  done
  case "$profile" in
    gateway|device-service|read-api|workflow-alerts|telemetry-ingest|saga-api)
      if ! grep -Fq 'kind: HorizontalPodAutoscaler' "$rendered" || \
        ! grep -Fq 'apiVersion: autoscaling/v2' "$rendered" || \
        grep -Fq '  replicas:' "$rendered"; then
        echo "$profile API profile is missing HPA v2 ownership of replica count" >&2
        exit 1
      fi
      ;;
    *)
      if grep -Fq 'kind: HorizontalPodAutoscaler' "$rendered"; then
        echo "$profile Kafka worker must not use HTTP CPU autoscaling" >&2
        exit 1
      fi
      ;;
  esac
  case "$profile" in
    gateway|device-service|read-api|workflow-alerts|telemetry-ingest|saga-api)
      assert_runtime_profile "$profile" hpa 2 10 30 ;;
    *) assert_runtime_profile "$profile" fixed 2 0 30 ;;
  esac
  case "$profile" in
    gateway)
      for expected in \
        'app: istio-ingressgateway' \
        'kubernetes.io/metadata.name: "istio-system"' \
        'app.kubernetes.io/name: greenguard-dashboard' \
        'app.kubernetes.io/instance: dashboard'; do
        if ! grep -Fq "$expected" "$rendered"; then
          echo "$profile ingress policy is missing an expected edge/dashboard peer: $expected" >&2
          exit 1
        fi
      done
      ;;
    device-service|telemetry-ingest)
      for expected in \
        'app.kubernetes.io/name: greenguard-dashboard' \
        'app.kubernetes.io/instance: dashboard'; do
        if ! grep -Fq "$expected" "$rendered"; then
          echo "$profile ingress policy is missing the dashboard peer selector: $expected" >&2
          exit 1
        fi
      done
      ;;
    read-api)
      for expected in \
        'app.kubernetes.io/name: gateway' \
        'app.kubernetes.io/instance: gateway' \
        'app.kubernetes.io/name: greenguard-bff' \
        'app.kubernetes.io/instance: bff'; do
        if ! grep -Fq "$expected" "$rendered"; then
          echo "$profile ingress policy is missing an expected BFF/gateway peer: $expected" >&2
          exit 1
        fi
      done
      ;;
    workflow-alerts)
      grep -Fq 'app.kubernetes.io/name: greenguard-bff' "$rendered"
      grep -Fq 'app.kubernetes.io/instance: bff' "$rendered"
      ;;
    saga-api)
      grep -Fq 'app.kubernetes.io/name: gateway' "$rendered"
      grep -Fq 'app.kubernetes.io/instance: gateway' "$rendered"
      grep -Fq 'app.kubernetes.io/name: greenguard-bff' "$rendered"
      grep -Fq 'app.kubernetes.io/instance: bff' "$rendered"
      grep -Fq 'secretName: saga-api-mtls' "$rendered"
      grep -Fq 'tcpSocket:' "$rendered"
      ;;
    cdc-transformer|projection-builder|cache-invalidator|risk-engine)
      if grep -Fq '    - from:' "$rendered"; then
        echo "$profile internal ingress policy unexpectedly allows a peer by default" >&2
        exit 1
      fi
      ;;
  esac
done

for profile in tenant-control-plane billing-service notification-service \
  jobs-worker cassandra-writer search-indexer; do
  values="$service_chart/values/$profile.yaml"
  helm lint "$service_chart" --values "$values" --set-string "image=$service_image"
  helm template "$profile" "$service_chart" --namespace greenguard \
    --values "$values" --set-string "image=$service_image" >"$rendered"
  for expected in 'runAsNonRoot: true' 'readOnlyRootFilesystem: true' \
    'allowPrivilegeEscalation: false' 'kind: NetworkPolicy' 'kind: Deployment'; do
    if ! grep -Fq "$expected" "$rendered"; then
      echo "$profile rendered manifest is missing required hardening: $expected" >&2
      exit 1
    fi
  done
  if [ "$profile" = search-indexer ]; then
    if grep -Fq 'readinessProbe:' "$rendered" || \
      ! grep -Fq 'claimName: search-indexer-quarantine' "$rendered"; then
      echo "search-indexer must use a durable quarantine claim and no fake HTTP readiness probe" >&2
      exit 1
    fi
  elif ! grep -Fq 'livenessProbe:' "$rendered"; then
    echo "$profile is missing its HTTP liveness probe" >&2
    exit 1
  fi
done

for profile in hardware-service-worker eventbridge-bridge saga-worker; do
  values="$service_chart/values/$profile.yaml"
  helm lint "$service_chart" --values "$values" --set-string "image=$service_image"
  helm template "$profile" "$service_chart" --namespace greenguard \
    --values "$values" --set-string "image=$service_image" >"$rendered"
  if grep -Eq '^kind: Service$' "$rendered" || \
    grep -Fq 'readinessProbe:' "$rendered" || \
    grep -Fq 'livenessProbe:' "$rendered"; then
    echo "$profile worker profile unexpectedly renders an HTTP Service or probe" >&2
    exit 1
  fi
  for expected in \
    'runAsNonRoot: true' \
    'readOnlyRootFilesystem: true' \
    'allowPrivilegeEscalation: false' \
    'kind: NetworkPolicy' \
    'kind: Deployment' \
    'terminationGracePeriodSeconds: 60' \
    'greenguard.io/workload-class: compute' \
    'effect: NoSchedule'; do
    if ! grep -Fq "$expected" "$rendered"; then
      echo "$profile worker manifest is missing required hardening: $expected" >&2
      exit 1
    fi
  done
  assert_runtime_profile "$profile" fixed 1 0 60
  if [ "$profile" = "eventbridge-bridge" ] && \
    ! grep -Fq 'serviceAccountName: eventbridge-bridge' "$rendered"; then
    echo "eventbridge-bridge workload identity service account name drifted" >&2
    exit 1
  fi
done

if helm template invalid-http-probes "$service_chart" \
  --set service.enabled=false \
  --set-string "image=$service_image" >/dev/null 2>&1; then
  echo "Runtime chart unexpectedly allowed HTTP probes without a Service port" >&2
  exit 1
fi

if helm template invalid-autoscaling "$service_chart" \
  --values "$service_chart/values/gateway.yaml" \
  --set-string "image=$service_image" \
  --set autoscaling.keda.enabled=true \
  --set-json 'autoscaling.keda.triggers=[{"type":"kafka","metadata":{"bootstrapServers":"kafka:9092","consumerGroup":"gateway","topic":"test","lagThreshold":"10"}}]' \
  >/dev/null 2>&1; then
  echo "Runtime chart unexpectedly allowed HPA and KEDA to own the same Deployment" >&2
  exit 1
fi
if helm template invalid-keda "$service_chart" \
  --values "$service_chart/values/hardware-service-worker.yaml" \
  --set-string "image=$service_image" \
  --set autoscaling.keda.enabled=true \
  >/dev/null 2>&1; then
  echo "Runtime chart unexpectedly allowed KEDA without a scaler trigger" >&2
  exit 1
fi
if helm template invalid-hpa-pdb "$service_chart" \
  --values "$service_chart/values/gateway.yaml" \
  --set-string "image=$service_image" \
  --set autoscaling.hpa.minReplicas=1 \
  --set pdb.minAvailable=1 \
  >/dev/null 2>&1; then
  echo "Runtime chart unexpectedly allowed a PDB that blocks the HPA minimum" >&2
  exit 1
fi
if helm template invalid-keda-pdb "$service_chart" \
  --values "$service_chart/values/hardware-service-worker.yaml" \
  --set-string "image=$service_image" \
  --set pdb.enabled=true \
  --set autoscaling.keda.enabled=true \
  --set autoscaling.keda.minReplicaCount=1 \
  --set-json 'autoscaling.keda.triggers=[{"type":"kafka","metadata":{"bootstrapServers":"kafka:9092","consumerGroup":"worker","topic":"commands","lagThreshold":"10"}}]' \
  >/dev/null 2>&1; then
  echo "Runtime chart unexpectedly allowed a PDB with KEDA minimum below two" >&2
  exit 1
fi

helm template hardware-service-worker "$service_chart" --namespace greenguard \
  --values "$service_chart/values/hardware-service-worker.yaml" \
  --set-string "image=$service_image" \
  --set autoscaling.keda.enabled=true \
  --set autoscaling.keda.minReplicaCount=1 \
  --set autoscaling.keda.maxReplicaCount=12 \
  --set-json 'autoscaling.keda.triggers=[{"type":"kafka","metadata":{"bootstrapServers":"kafka:9092","consumerGroup":"greenguard.hardware.v1","topic":"greenguard.saga.commands.v1","lagThreshold":"100","offsetResetPolicy":"earliest"}}]' \
  >"$rendered"
for expected in \
  'apiVersion: keda.sh/v1alpha1' \
  'kind: ScaledObject' \
  'minReplicaCount: 1' \
  'maxReplicaCount: 12' \
  'consumerGroup: greenguard.hardware.v1' \
  'topic: greenguard.saga.commands.v1'; do
  if ! grep -Fq "$expected" "$rendered"; then
    echo "KEDA worker profile is missing configured scaling behavior: $expected" >&2
    exit 1
  fi
done
if grep -Fq '  replicas:' "$rendered" || grep -Fq 'kind: HorizontalPodAutoscaler' "$rendered"; then
  echo "KEDA must own the worker replica count without an overlapping HPA" >&2
  exit 1
fi

assert_runtime_profile hardware-service-worker keda 1 12 60
for mutation in kind apiVersion; do
  assert_autoscaler_drift_rejected "$mutation" hardware-service-worker keda 1 12 60
done

# Boundary acceptance: HPA floor one without a PDB, KEDA scale-to-zero without
# a PDB, and KEDA minimum two with a compatible PDB.
helm template gateway "$service_chart" --values "$service_chart/values/gateway.yaml" \
  --set-string "image=$service_image" --set pdb.enabled=false \
  --set autoscaling.hpa.minReplicas=1 --set autoscaling.hpa.maxReplicas=2 >"$rendered"
# A PDB is deliberately disabled at a single replica.
assert_runtime_profile gateway hpa 1 2 30 default no-pdb
for mutation in kind apiVersion metricType metricName metricTarget; do
  assert_autoscaler_drift_rejected "$mutation" gateway hpa 1 2 30 default no-pdb
done
for minimum in 0 2; do
  pdb=false
  if [ "$minimum" = 2 ]; then pdb=true; fi
  helm template hardware-service-worker "$service_chart" \
    --values "$service_chart/values/hardware-service-worker.yaml" \
    --set-string "image=$service_image" --set "pdb.enabled=$pdb" \
    --set autoscaling.keda.enabled=true --set "autoscaling.keda.minReplicaCount=$minimum" \
    --set autoscaling.keda.maxReplicaCount=3 \
    --set-json 'autoscaling.keda.triggers=[{"type":"kafka","metadata":{"bootstrapServers":"kafka:9092","consumerGroup":"worker","topic":"commands","lagThreshold":"10"}}]' >"$rendered"
  assert_runtime_profile hardware-service-worker keda "$minimum" 3 60
  if [ "$minimum" = 2 ] && ! grep -Fq 'kind: PodDisruptionBudget' "$rendered"; then
    echo 'KEDA minimum two fixture must render its compatible PDB' >&2; exit 1
  fi
done

for bounds in '2 2' '3 2'; do
  read -r minimum maximum <<<"$bounds"
  expect_runtime_rejection invalid-hpa-range 'HPA requires minReplicas < maxReplicas' \
    --values "$service_chart/values/gateway.yaml" \
    --set "autoscaling.hpa.minReplicas=$minimum" --set "autoscaling.hpa.maxReplicas=$maximum"
  expect_runtime_rejection invalid-keda-range 'KEDA requires minReplicaCount < maxReplicaCount' \
    --values "$service_chart/values/hardware-service-worker.yaml" \
    --set autoscaling.keda.enabled=true --set "autoscaling.keda.minReplicaCount=$minimum" \
    --set "autoscaling.keda.maxReplicaCount=$maximum" \
    --set-json 'autoscaling.keda.triggers=[{"type":"kafka","metadata":{"topic":"commands"}}]'
done
for setting in autoscaling.hpa.minReplicas=0 autoscaling.hpa.maxReplicas=1 terminationGracePeriodSeconds=0 terminationGracePeriodSeconds=601; do
  expect_runtime_rejection invalid-schema 'values don' \
    --values "$service_chart/values/gateway.yaml" --set "$setting"
done
expect_runtime_rejection invalid-keda-negative 'values don' \
  --values "$service_chart/values/hardware-service-worker.yaml" --set autoscaling.keda.minReplicaCount=-1
expect_runtime_rejection invalid-keda-max 'values don' \
  --values "$service_chart/values/hardware-service-worker.yaml" --set autoscaling.keda.maxReplicaCount=0
expect_runtime_rejection invalid-keda-pdb-equal 'pdb.minAvailable must be less' \
  --values "$service_chart/values/hardware-service-worker.yaml" --set pdb.enabled=true \
  --set pdb.minAvailable=2 --set autoscaling.keda.enabled=true --set autoscaling.keda.minReplicaCount=2 \
  --set-json 'autoscaling.keda.triggers=[{"type":"kafka","metadata":{"topic":"commands"}}]'

expect_runtime_rejection invalid-worker-hpa 'autoscaling.hpa requires service.enabled=true' \
  --values "$service_chart/values/hardware-service-worker.yaml" --set autoscaling.hpa.enabled=true

# Optional scheduling configuration is a render fixture, not a claim that the
# named PriorityClass or zones exist in a cluster.
for mutation in valid selector toleration topology priority grace; do
  extra=(--set terminationGracePeriodSeconds=60)
  case "$mutation" in
    selector) extra=(--set-string 'scheduling.nodeSelector.greenguard\.io/workload-class=general') ;;
    toleration) extra=(--set scheduling.tolerations[0].value=general) ;;
    topology) extra=(--set scheduling.topologySpreadConstraints[0].maxSkew=2) ;;
    priority) extra=(--set scheduling.priorityClassName=wrong-priority) ;;
    grace) extra=(--set terminationGracePeriodSeconds=30) ;;
  esac
  helm template hardware-service-worker "$service_chart" \
    --values "$service_chart/values/hardware-service-worker.yaml" \
    --set-string "image=$service_image" --set scheduling.priorityClassName=greenguard-compute \
    --set-json 'scheduling.topologySpreadConstraints=[{"maxSkew":1,"topologyKey":"topology.kubernetes.io/zone","whenUnsatisfiable":"DoNotSchedule","labelSelector":{"matchLabels":{"app.kubernetes.io/name":"hardware-service-worker","app.kubernetes.io/instance":"hardware-service-worker"}}}]' \
    "${extra[@]}" >"$rendered"
  if [ "$mutation" = valid ]; then
    assert_runtime_profile hardware-service-worker fixed 1 0 60 spread
  elif assert_runtime_profile hardware-service-worker fixed 1 0 60 spread 2>"$bff_rendered"; then
    echo "Scheduling gate unexpectedly accepted $mutation drift" >&2; exit 1
  else
    case "$mutation" in
      selector) diagnostic='worker must select compute nodes' ;;
      toleration) diagnostic='worker must tolerate the compute NoSchedule taint' ;;
      topology) diagnostic='zone spread fields drifted' ;;
      priority) diagnostic='configured priority class drifted' ;;
      grace) diagnostic='shutdown grace drifted' ;;
    esac
    if ! grep -Fq "$diagnostic" "$bff_rendered"; then
      echo "$mutation: scheduling rejection had an unexpected cause" >&2
      cat "$bff_rendered" >&2; exit 1
    fi
    echo "Expected scheduling rejection: $mutation ($diagnostic)"
  fi
done

if helm template greenguard "$chart" >/dev/null 2>&1; then
  echo "Helm chart unexpectedly rendered without an immutable image digest" >&2
  exit 1
fi
if helm template greenguard "$chart" --set-string "image=$image" \
  --skip-schema-validation \
  --set networkPolicy.enabled=false \
  --set observability.prometheus.enabled=true >/dev/null 2>&1; then
  echo "Helm chart unexpectedly allowed Envoy scraping while mesh is disabled" >&2
  exit 1
fi
if helm template greenguard "$chart" --set-string "image=$image" \
  --skip-schema-validation \
  --set mesh.enabled=true \
  --set observability.prometheus.enabled=true \
  --set networkPolicy.enabled=false \
  --set observability.prometheus.mergeMetrics=false >/dev/null 2>&1; then
  echo "Helm chart unexpectedly allowed a merged-metrics port mismatch" >&2
  exit 1
fi
if helm template invalid-service-observability "$service_chart" \
  --set-string "image=$service_image" \
  --skip-schema-validation \
  --set networkPolicy.enabled=false \
  --set observability.prometheus.enabled=true >/dev/null 2>&1; then
  echo "Runtime chart unexpectedly allowed Envoy scraping while mesh is disabled" >&2
  exit 1
fi
if helm template invalid-bff-observability "$bff_chart" \
  --set-string "image=$bff_image" \
  --skip-schema-validation \
  --set networkPolicy.enabled=false \
  --set observability.prometheus.enabled=true >/dev/null 2>&1; then
  echo "BFF chart unexpectedly allowed Envoy scraping while mesh is disabled" >&2
  exit 1
fi
if helm template greenguard "$chart" --set-string "image=$image" \
  --set replicaCount=2 --set pdb.enabled=true --set pdb.minAvailable=2 >/dev/null 2>&1; then
  echo "Helm chart unexpectedly allowed a PDB that blocks all voluntary disruptions" >&2
  exit 1
fi
if helm template greenguard "$chart" --set-string "image=$image" \
  --set mesh.enabled=true \
  --set mesh.strictMtls=true \
  --set mesh.authorization.enabled=true >/dev/null 2>&1; then
  echo "Helm chart unexpectedly allowed AuthorizationPolicy without principals" >&2
  exit 1
fi

helm lint "$chart" --set-string "image=$image"
helm template greenguard "$chart" --namespace greenguard --set-string "image=$image" >"$rendered"

for expected in \
  'image: "ghcr.io/pahuldeepp/grainguard/dashboard@sha256:' \
  'runAsNonRoot: true' \
  'readOnlyRootFilesystem: true' \
  'allowPrivilegeEscalation: false' \
  'drop:' \
  'policyTypes:' \
  'kubernetes.io/metadata.name: "greenguard"' \
  'app.kubernetes.io/instance: "gateway"' \
  'maxUnavailable: 0' \
  'kind: PodDisruptionBudget' \
  'minAvailable: 1' \
  'sidecar.istio.io/inject: "false"' \
  'name: "greenguard-greenguard-dashboard"' \
  'path: /healthz'; do
  if ! grep -Fq "$expected" "$rendered"; then
    echo "Rendered chart is missing required hardening: $expected" >&2
    exit 1
  fi
done

helm template greenguard "$chart" --namespace greenguard \
  --set-string "image=$image" \
  --set mesh.enabled=true \
  --set mesh.revision=stable \
  --set mesh.strictMtls=true \
  --set mesh.authorization.enabled=true \
  --set 'mesh.authorization.allowedPrincipals[0]=cluster.local/ns/greenguard/sa/ingress-gateway' \
  --set observability.collector.enabled=true \
  --set observability.prometheus.enabled=true >"$mesh_rendered"

for expected in \
  'sidecar.istio.io/inject: "true"' \
  'istio.io/rev: "stable"' \
  'kubernetes.io/metadata.name: "istio-system"' \
  'port: 15012' \
  'kubernetes.io/metadata.name: "observability"' \
  'port: 4317' \
  'kubernetes.io/metadata.name: "monitoring"' \
  'port: 15020' \
  'prometheus.io/path: /stats/prometheus' \
  'prometheus.istio.io/merge-metrics: "true"' \
  'kind: PeerAuthentication' \
  'mode: STRICT' \
  'kind: AuthorizationPolicy' \
  'principals:' \
  'cluster.local/ns/greenguard/sa/ingress-gateway'; do
  if ! grep -Fq "$expected" "$mesh_rendered"; then
    echo "Mesh-enabled chart is missing required policy: $expected" >&2
    exit 1
  fi
done

helm template field-trial "$chart" --namespace greenguard \
  --set-string "image=$image" >"$mesh_rendered"
grep -Fq 'name: "field-trial-greenguard-dashboard"' "$mesh_rendered"
grep -Fq 'app: istio-ingressgateway' "$mesh_rendered"

if helm template invalid-rollout "$chart" --namespace greenguard \
  --set-string "image=$image" --set rollouts.enabled=true \
  >/dev/null 2>&1; then
  echo "Dashboard chart unexpectedly enabled canary without Prometheus analysis configuration" >&2
  exit 1
fi
helm template canary-dashboard "$chart" --namespace greenguard \
  --set-string "image=$image" \
  --set rollouts.enabled=true \
  --set-string rollouts.analysis.prometheusAddress=http://prometheus.monitoring.svc:9090 \
  --set-string rollouts.analysis.successRateQuery=vector\(1\) >"$rollout_rendered"
for expected in \
  'apiVersion: argoproj.io/v1alpha1' \
  'kind: Rollout' \
  'kind: AnalysisTemplate' \
  'setWeight: 25' \
  'setWeight: 50' \
  'successCondition: "result[0] >= 0.99"' \
  'query: "vector(1)"'; do
  if ! grep -Fq "$expected" "$rollout_rendered"; then
    echo "Dashboard canary render is missing its analysis gate: $expected" >&2
    exit 1
  fi
done

helm lint "$bff_chart" --set-string "image=$bff_image"
if helm template greenguard "$bff_chart" >/dev/null 2>&1; then
  echo "BFF Helm chart unexpectedly rendered without an immutable image digest" >&2
  exit 1
fi
helm template greenguard "$bff_chart" --namespace greenguard \
  --set-string "image=$bff_image" >"$bff_rendered"
for expected in \
  'image: "ghcr.io/pahuldeepp/grainguard/bff@sha256:' \
  'containerPort: 4000' \
  'apiVersion: autoscaling/v2' \
  'kind: HorizontalPodAutoscaler' \
  'minReplicas: 2' \
  'maxReplicas: 10' \
  'averageUtilization: 70' \
  'path: /healthz' \
  'path: /readyz' \
  'kubernetes.io/metadata.name: "istio-system"' \
  'app: istio-ingressgateway' \
  'readOnlyRootFilesystem: true' \
  'kind: PodDisruptionBudget' \
  'sidecar.istio.io/inject: "false"'; do
  if ! grep -Fq "$expected" "$bff_rendered"; then
    echo "Rendered BFF chart is missing required baseline: $expected" >&2
    exit 1
  fi
done
if grep -Fq '  replicas:' "$bff_rendered"; then
  echo "BFF Deployment must leave replicas to the HPA" >&2
  exit 1
fi

ruby infra/gitops/disposable/check-network-peers.rb

echo "Dashboard, BFF, runtime API and worker profiles linted; digest rejection, hardened defaults, optional mesh/OTel policy, HPA, KEDA, Argo Rollouts canary analysis, Saga mTLS references, worker isolation, ports/probes, ingress selectors, rendered peer links, structured per-profile replica ownership/PDB/grace, scaling boundaries, and scheduling drift rejection checks passed."
