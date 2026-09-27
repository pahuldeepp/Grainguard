#!/usr/bin/env bash
set -euo pipefail

workflow=.github/workflows/ci.yml
repositories=infra/terraform/platform/variables.tf
images=(
  'dashboard:apps/dashboard/Dockerfile'
  'bff:services/bff/Dockerfile'
  'gateway:services/gateway/Dockerfile'
  'device-service:services/device-service/Dockerfile'
  'read-api:services/read-api/Dockerfile'
  'workflow-alerts:services/workflow-alerts/Dockerfile'
  'telemetry-ingest:services/telemetry-ingest/Dockerfile'
  'cdc-transformer:services/cdc-transformer/Dockerfile'
  'projection-builder:services/projection-builder/Dockerfile'
  'cache-invalidator:services/cache-invalidator/Dockerfile'
  'risk-engine:services/risk-engine/Dockerfile'
  'hardware-service:services/hardware-service/Dockerfile'
  'eventbridge-bridge:services/eventbridge-bridge/Dockerfile'
  'saga-orchestrator:services/saga-orchestrator/Dockerfile'
)

for image in "${images[@]}"; do
  service="${image%%:*}"
  dockerfile="${image#*:}"
  if [[ ! -f "$dockerfile" ]]; then
    echo "Missing Dockerfile for published image $service: $dockerfile" >&2
    exit 1
  fi
  if ! awk -v service="$service" -v dockerfile="$dockerfile" '
    $0 == "          - service: " service {
      getline
      if ($0 == "            dockerfile: " dockerfile) matches++
    }
    END { exit matches != 1 }
  ' "$workflow"; then
    echo "CI publication matrix is missing or misroutes image $service" >&2
    exit 1
  fi
  if [[ "$(grep -Fxc "            dockerfile: $dockerfile" "$workflow")" != 1 ]]; then
    echo "CI matrix must reference $dockerfile exactly once" >&2
    exit 1
  fi
  if ! grep -Fq "\"$service\"" "$repositories"; then
    echo "Terraform ECR repository inventory is missing $service" >&2
    exit 1
  fi
done

runtime_dockerfiles=()
while IFS= read -r dockerfile; do
  runtime_dockerfiles+=("$dockerfile")
done < <(git ls-files --cached --others --exclude-standard apps services infra | grep -E '(^|/)Dockerfile$' | sort)
if [[ ${#runtime_dockerfiles[@]} -eq 0 ]]; then
  echo "No runtime Dockerfiles found; refusing to pass the inventory check" >&2
  exit 1
fi
for dockerfile in "${runtime_dockerfiles[@]}"; do
  case "$dockerfile" in
    infra/compose/pgbouncer/Dockerfile) continue ;;
  esac
  if ! grep -Fq "dockerfile: $dockerfile" "$workflow"; then
    echo "Runtime Dockerfile is absent from the image publication matrix: $dockerfile" >&2
    exit 1
  fi
done

echo "All dashboard and runtime Dockerfiles map to CI image builds and Terraform ECR repositories."
