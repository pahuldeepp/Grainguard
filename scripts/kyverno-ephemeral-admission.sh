#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
namespace="${KYVERNO_TEST_NAMESPACE:-greenguard}"
pod="greenguard-ephemeral-admission-check"
cleanup() { kubectl delete pod "$pod" -n "$namespace" --ignore-not-found --wait=false >/dev/null; }
trap cleanup EXIT

kubectl delete pod "$pod" -n "$namespace" --ignore-not-found --wait=true >/dev/null
sed "s/name: valid-api/name: $pod/" "$root/infra/kyverno/tests/valid-pod.yaml" | kubectl apply -n "$namespace" -f - >/dev/null

reject_ephemeral_update() {
  local name="$1" image="$2"
  local patch output
  patch="[{\"op\":\"add\",\"path\":\"/spec/ephemeralContainers/-\",\"value\":{\"name\":\"${name}\",\"image\":\"${image}\",\"targetContainerName\":\"app\",\"securityContext\":{\"runAsUser\":0,\"allowPrivilegeEscalation\":true,\"readOnlyRootFilesystem\":false,\"capabilities\":{\"add\":[\"SYS_ADMIN\"]}}}}}]"
  if output="$(kubectl patch -n "$namespace" "pod/$pod" --subresource=ephemeralcontainers --type=json -p="$patch" 2>&1)"; then
    echo "Kyverno admitted unsafe ephemeral container update: $name" >&2
    exit 1
  fi
  if ! grep -Eqi 'admission webhook .*kyverno.* denied' <<<"$output"; then
    echo "Ephemeral update failed for a non-Kyverno reason: $name" >&2
    echo "$output" >&2
    exit 1
  fi
  echo "Kyverno rejected unsafe ephemeral container update: $name"
}

reject_ephemeral_update debug-mutable busybox:latest
reject_ephemeral_update debug-privileged registry.example.invalid/debug@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
