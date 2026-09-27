#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

digest='registry.example.invalid/greenguard/mosquitto@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
rendered="$(helm template mqtt . --set "image=$digest")"
for required in 'allow_anonymous false' 'password_file /run/mqtt-auth/passwords' 'acl_file /run/mqtt-auth/acl' 'listener 8883' 'persistence true' 'kind: StatefulSet' 'kind: NetworkPolicy' 'storage: "5Gi"' 'type: ClusterIP' 'readOnlyRootFilesystem: true' 'sidecar.istio.io/inject: "false"'; do
  if [[ "$rendered" != *"$required"* ]]; then
    echo "MQTT chart missing required contract: $required" >&2
    exit 1
  fi
done
if helm template mqtt . >/dev/null 2>&1; then
  echo 'MQTT chart accepted an absent image digest' >&2
  exit 1
fi
if helm template mqtt . --set image=eclipse-mosquitto:2 >/dev/null 2>&1; then
  echo 'MQTT chart accepted a mutable image tag' >&2
  exit 1
fi
if helm template mqtt . --set "image=$digest" --set storageSize=0Gi >/dev/null 2>&1; then
  echo 'MQTT chart accepted zero storage' >&2
  exit 1
fi
external_args=(--set "image=$digest" --set external.enabled=true --set external.hostname=sensors.example.org --set 'external.sourceCIDRs[0]=203.0.113.7/32' --set 'external.nlbSubnetCIDRs[0]=10.20.1.0/24')
external_rendered="$(helm template mqtt . "${external_args[@]}")"
for required in 'name: mqtt-device-ingress' 'name: greenguard-mqtt-nlb-ingress' 'loadBalancerSourceRanges:' '203.0.113.7/32' '10.20.1.0/24' 'aws-load-balancer-scheme: "internet-facing"' 'preserve_client_ip.enabled=false'; do
  if [[ "$external_rendered" != *"$required"* ]]; then
    echo "external MQTT chart missing required contract: $required" >&2
    exit 1
  fi
done
for invalid in '--set external.enabled=true' '--set external.enabled=true --set external.hostname=sensors.example.org' '--set external.enabled=true --set external.hostname=sensors.example.org --set external.sourceCIDRs[0]=0.0.0.0/0 --set external.nlbSubnetCIDRs[0]=10.20.1.0/24' '--set external.enabled=true --set external.hostname=sensors.example.org --set external.sourceCIDRs[0]=203.0.113.7/32 --set external.nlbSubnetCIDRs[0]=0.0.0.0/0'; do
  read -r -a invalid_args <<< "$invalid"
  if helm template mqtt . --set "image=$digest" "${invalid_args[@]}" >/dev/null 2>&1; then
    echo "external MQTT chart accepted unsafe input: $invalid" >&2
    exit 1
  fi
done
echo 'MQTT chart render and rejection checks passed'
