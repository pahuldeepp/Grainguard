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
  'tenant-control-plane:services/tenant-control-plane/Dockerfile'
  'billing-service:services/billing-service/Dockerfile'
  'notification-service:services/notification-service/Dockerfile'
  'jobs-worker:services/jobs-worker/Dockerfile'
  'cassandra-writer:services/cassandra-writer/Dockerfile'
  'search-indexer:services/search-indexer/Dockerfile'
)

migrations=(
  'control:tenant-control-plane:services/tenant-control-plane/Dockerfile'
  'billing:billing-service:services/billing-service/Dockerfile'
  'telemetry:telemetry-ingest:services/telemetry-ingest/Dockerfile'
  'projection:projection-builder:services/projection-builder/Dockerfile'
  'jobs:jobs-worker:services/jobs-worker/Dockerfile'
  'saga:saga-orchestrator:services/saga-orchestrator/Dockerfile'
  'hardware:hardware-service:services/hardware-service/Dockerfile'
  'inventory:device-service:services/device-service/Dockerfile'
  'alerts:workflow-alerts:services/workflow-alerts/Dockerfile'
  'risk:risk-engine:services/risk-engine/Dockerfile'
  'notifications:notification-service:services/notification-service/Dockerfile'
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
  expected_matrix_references=1
  for migration in "${migrations[@]}"; do
    if [[ "${migration##*:}" == "$dockerfile" ]]; then
      expected_matrix_references=2
      break
    fi
  done
  if [[ "$(grep -Fxc "            dockerfile: $dockerfile" "$workflow")" != "$expected_matrix_references" ]]; then
    echo "CI matrix must reference $dockerfile exactly $expected_matrix_references time(s), once per build target" >&2
    exit 1
  fi
  if ! grep -Fq "\"$service\"" "$repositories"; then
    echo "Terraform ECR repository inventory is missing $service" >&2
    exit 1
  fi
done

for migration in "${migrations[@]}"; do
  owner="${migration%%:*}"
  remainder="${migration#*:}"
  image="${remainder%%:*}"
  dockerfile="${remainder#*:}"
  if ! awk -v owner="$owner" -v image="$image" -v dockerfile="$dockerfile" '
    $0 == "          - owner: " owner {
      getline
      if ($0 == "            image: migration-" owner) {
        getline
        if ($0 == "            dockerfile: " dockerfile) {
          getline
          if ($0 == "            target: migration") matches++
        }
      }
    }
    END { exit matches != 1 }
  ' "$workflow"; then
    echo "CI migration publication matrix is missing or misroutes owner $owner ($image)" >&2
    exit 1
  fi
  if [[ "$(grep -Fxc "            dockerfile: $dockerfile" "$workflow")" != 2 ]]; then
    echo "CI must reference runtime and migration targets exactly once for $dockerfile" >&2
    exit 1
  fi
  if ! grep -Fq "migration-$owner" "$repositories"; then
    echo "Terraform ECR repository inventory is missing migration-$owner" >&2
    exit 1
  fi
done

for tool in gate sql; do
  image="migration-$tool"
  if ! grep -Fq "image: $image" "$workflow" || ! grep -Fq "\"$image\"" "$repositories"; then
    echo "CI/Terraform migration tool image inventory is missing $image" >&2
    exit 1
  fi
done
if ! grep -Fq 'migration-gate-image/Dockerfile' "$workflow" ||
   ! grep -Fq 'migration-sql-image.Dockerfile' "$workflow" ||
   ! grep -Fq '6129359f4e1f3848a5572ccb0b26cf28b8ca08cef38c95a765b2f64a2c961a2f' "$workflow"; then
  echo "CI must build both pinned migration tools and verify the kubectl binary checksum" >&2
  exit 1
fi

expected_repositories=()
for image in "${images[@]}"; do
  expected_repositories+=("${image%%:*}")
done
for migration in "${migrations[@]}"; do
  owner="${migration%%:*}"
  expected_repositories+=("migration-$owner")
done
expected_repositories+=(migration-gate migration-sql)
actual_repositories="$(awk '
  /variable "image_repositories"/ {in_block=1}
  in_block && /default = \[/ {collect=1; next}
  collect {
    if ($0 ~ /\]/) exit
    gsub(/[",]/, " ")
    for (i=1; i<=NF; i++) print $i
  }
' "$repositories")"
expected_sorted="$(printf '%s\n' "${expected_repositories[@]}" | sort)"
actual_sorted="$(printf '%s\n' "$actual_repositories" | sort)"
if [[ "$actual_sorted" != "$expected_sorted" ]]; then
  echo "Terraform platform ECR repositories must exactly match the 20 runtime, 11 owner migration and 2 tool images" >&2
  diff -u <(printf '%s\n' "$expected_sorted") <(printf '%s\n' "$actual_sorted") >&2 || true
  exit 1
fi

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
    infra/gitops/disposable/migration-gate-image/Dockerfile|infra/gitops/disposable/migration-sql-image.Dockerfile) continue ;;
  esac
  if ! grep -Fq "dockerfile: $dockerfile" "$workflow"; then
    echo "Runtime Dockerfile is absent from the image publication matrix: $dockerfile" >&2
    exit 1
  fi
done

echo "Runtime and all 11 owner-migration Dockerfiles plus the kubectl/PostgreSQL tools map to CI builds and immutable ECR repositories."
