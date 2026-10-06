#!/usr/bin/env bash
set -euo pipefail

workflow=.github/workflows/ci.yml

# Keep the verified Sigstore v4.1.2 action commit pinned in all three image-signing jobs.
cosign_pin='sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6 # v4.1.2'
cosign_pin_count="$(grep -Fxc "        uses: $cosign_pin" "$workflow")"
if [[ "$cosign_pin_count" != 3 ]]; then
  echo "All three image-signing jobs must use the verified sigstore/cosign-installer v4.1.2 commit (found $cosign_pin_count pins)" >&2
  exit 1
fi
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
  'telemetry-sinks:services/telemetry-sinks/deploy/Dockerfile'
  'knowledge-service:services/knowledge-service/Dockerfile'
  'knowledge-parser:services/knowledge-service/Dockerfile.parser'
  'knowledge-indexer:services/knowledge-service/Dockerfile.indexer'
  'grain-advisor:services/grain-advisor/Dockerfile'
  'model-gateway:services/model-gateway/Dockerfile'
  'model-gateway-usage:services/model-gateway/Dockerfile.usage'
  'mcp-gateway:services/mcp-gateway/Dockerfile'
  'ml-scoring-synthetic:services/ml-scoring/deploy/Dockerfile'
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

if ! ruby -rjson -e '
  inventory = JSON.parse(File.read(ARGV.fetch(0))).fetch("ai_runtime_images")
  expected = {
    "knowledge-service" => ["source_present", "services/knowledge-service/Dockerfile"],
    "knowledge-indexer" => ["source_present", "services/knowledge-service/Dockerfile.indexer"],
    "knowledge-parser" => ["source_present", "services/knowledge-service/Dockerfile.parser"],
    "grain-advisor" => ["source_present", "services/grain-advisor/Dockerfile"],
    "mcp-gateway" => ["source_present", "services/mcp-gateway/Dockerfile"],
    "model-gateway" => ["source_present", "services/model-gateway/Dockerfile"],
    "model-gateway-usage" => ["source_present", "services/model-gateway/Dockerfile.usage"]
  }
  actual = inventory.to_h { |entry| [entry.fetch("name"), [entry.fetch("status"), entry.fetch(entry.fetch("status") == "source_present" ? "dockerfile" : "expectedDockerfile")]] }
  abort "AI runtime source inventory mismatch" unless actual == expected
  expected.each do |name, (status, path)|
    exists = File.file?(path)
    abort "#{name}: inventory source status does not match filesystem" unless exists == (status == "source_present")
  end
  workflow = File.read(ARGV.fetch(1))
  abort "CI AI matrix does not cover every checked-in image" unless expected.all? { |name, (_status, path)| workflow.include?("dockerfile: #{path}") }
' infra/gitops/disposable/platform-image-inventory.json .github/workflows/ci.yml; then
  echo "AI image source coverage is invalid" >&2
  exit 1
fi

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

support_builds=(
  'pgbouncer:infra/compose/pgbouncer/Dockerfile'
  'kafka-connect:infra/kafka/Dockerfile.connect'
  'connector-registration:infra/gitops/disposable/connector-registration/Dockerfile'
)
for support in "${support_builds[@]}"; do
  image="${support%%:*}"
  dockerfile="${support#*:}"
  if ! awk -v image="$image" -v dockerfile="$dockerfile" '
    $0 == "          - image: " image {
      found_image=1
      while (getline && $0 !~ /^          - image:/) {
        if ($0 == "            dockerfile: " dockerfile) matches++
      }
    }
    END { exit matches != 1 }
  ' "$workflow"; then
    echo "CI platform matrix is missing or misroutes $image ($dockerfile)" >&2
    exit 1
  fi
done

platform_names=(otel-collector prometheus grafana tempo loki pgbouncer kafka-topics kafka-connect connector-registration opensearch cassandra mqtt clickhouse clamav)
if ! ruby -rjson -e '
  entries = JSON.parse(File.read(ARGV.fetch(0))).fetch("images")
  expected = ARGV.drop(1).sort
  actual = entries.map { |entry| entry.fetch("name") }.sort
  abort "platform source inventory mismatch" unless actual == expected
  entries.each do |entry|
    if entry.fetch("kind").start_with?("vendor")
      abort "#{entry.fetch("name")}: vendor source is not pinned by digest" unless entry.fetch("source").match?(/@sha256:[a-f0-9]{64}$/)
    else
      abort "#{entry.fetch("name")}: repository Dockerfile missing" unless File.file?(entry.fetch("dockerfile"))
    end
  end
' infra/gitops/disposable/platform-image-inventory.json "${platform_names[@]}"; then
  echo "Platform image provenance inventory is invalid" >&2
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
expected_repositories+=(otel-collector prometheus grafana tempo loki pgbouncer kafka-topics kafka-connect connector-registration opensearch cassandra mqtt clickhouse clamav)
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
  echo "Terraform platform ECR repositories must match all CI runtime/AI, owner migration/tool and platform images" >&2
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

echo "Runtime, AI, and platform images, all 11 owner-migration Dockerfiles, and migration tools map to CI builds and immutable ECR repositories."
