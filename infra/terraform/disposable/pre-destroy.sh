#!/usr/bin/env bash
# Run by `terraform destroy` (teardown.tf) before the cluster and VPC are deleted.
# Removes AWS resources that live outside this Terraform state. Exits non-zero,
# which stops the destroy, if anything that would block or keep billing remains.
set -euo pipefail

: "${GG_CLUSTER:?}" "${GG_REGION:?}" "${GG_ENVIRONMENT:?}" "${GG_ACCOUNT:?}"
export AWS_REGION="$GG_REGION" AWS_PAGER=""
WAIT_SECONDS="${GG_WAIT_SECONDS:-900}"

if [ "$GG_ENVIRONMENT" = "prod" ]; then
  echo "pre-destroy: refusing to tear down environment 'prod' from the disposable root" >&2
  exit 1
fi
for tool in aws kubectl; do
  command -v "$tool" >/dev/null || { echo "pre-destroy: $tool is required" >&2; exit 1; }
done

actual_account="$(aws sts get-caller-identity --query Account --output text)"
if [ "$actual_account" != "$GG_ACCOUNT" ]; then
  echo "pre-destroy: AWS identity is in account $actual_account, expected $GG_ACCOUNT" >&2
  exit 1
fi

log() { echo "pre-destroy: $*"; }

# 1. CDK serverless stack for this environment (see infra/cdk/app.py).
stack="GreenGuardServerless-$GG_ENVIRONMENT"
stack_error="$(mktemp)"
trap 'rm -f "$stack_error"' EXIT
if aws cloudformation describe-stacks --stack-name "$stack" >/dev/null 2>"$stack_error"; then
  log "deleting CloudFormation stack $stack"
  aws cloudformation delete-stack --stack-name "$stack"
  aws cloudformation wait stack-delete-complete --stack-name "$stack"
else
  if grep -q 'does not exist' "$stack_error"; then
    log "no CloudFormation stack $stack"
  else
    cat "$stack_error" >&2
    exit 1
  fi
fi

# Lambda-created log groups are not CloudFormation resources in this CDK stack.
# Delete the two exact, environment-scoped groups after the functions are gone.
for log_group in \
  "/aws/lambda/greenguard-escalation-mirror-$GG_ENVIRONMENT" \
  "/aws/lambda/greenguard-notification-dispatch-$GG_ENVIRONMENT"; do
  existing="$(aws logs describe-log-groups --log-group-name-prefix "$log_group" \
    --query 'logGroups[].logGroupName' --output text)"
  if printf '%s\n' "$existing" | tr '\t' '\n' | grep -Fxq "$log_group"; then
    log "deleting log group $log_group"
    aws logs delete-log-group --log-group-name "$log_group"
  fi
done

# 2. Kubernetes owners of AWS resources: ingresses, LoadBalancer services, volumes.
cluster_error="$(mktemp)"
trap 'rm -f "$stack_error" "$cluster_error"' EXIT
if aws eks describe-cluster --name "$GG_CLUSTER" >/dev/null 2>"$cluster_error"; then
  kubeconfig="$(mktemp)"
  trap 'rm -f "$stack_error" "$cluster_error" "$kubeconfig"' EXIT
  aws eks update-kubeconfig --name "$GG_CLUSTER" --kubeconfig "$kubeconfig" >/dev/null
  k() { kubectl --kubeconfig "$kubeconfig" --request-timeout=60s "$@"; }

  log "deleting ingresses"
  k delete ingress --all --all-namespaces --wait=true --timeout=10m
  log "deleting LoadBalancer services"
  k get service --all-namespaces \
    -o jsonpath='{range .items[?(@.spec.type=="LoadBalancer")]}{.metadata.namespace}{" "}{.metadata.name}{"\n"}{end}' |
    while read -r namespace name; do
      [ -n "$name" ] && k delete service -n "$namespace" "$name" --wait=true --timeout=10m
    done
  log "deleting persistent volume claims"
  k delete pvc --all --all-namespaces --wait=true --timeout=10m
else
  if grep -q 'ResourceNotFoundException' "$cluster_error"; then
    log "cluster $GG_CLUSTER not found; skipping Kubernetes cleanup"
  else
    cat "$cluster_error" >&2
    exit 1
  fi
fi

# 3. Wait until controllers have removed the load balancers they own; these
#    hold ENIs and security groups in the VPC and would block its deletion.
tagged_load_balancers() {
  for key in "elbv2.k8s.aws/cluster" "kubernetes.io/cluster/$GG_CLUSTER"; do
    values=()
    [ "$key" = "elbv2.k8s.aws/cluster" ] && values=(Values="$GG_CLUSTER")
    aws resourcegroupstaggingapi get-resources \
      --resource-type-filters elasticloadbalancing:loadbalancer \
      --tag-filters "Key=$key${values:+,${values[0]}}" \
      --query 'ResourceTagMappingList[].ResourceARN' --output text
  done | tr '\t' '\n' | sed '/^$/d;/^None$/d' | sort -u
}

deadline=$((SECONDS + WAIT_SECONDS))
while :; do
  remaining="$(tagged_load_balancers)"
  [ -z "$remaining" ] && break
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "pre-destroy: load balancers still present after ${WAIT_SECONDS}s:" >&2
    echo "$remaining" >&2
    exit 1
  fi
  log "waiting for load balancers to be removed: $(echo "$remaining" | wc -l | tr -d ' ') left"
  sleep 15
done
log "done"
