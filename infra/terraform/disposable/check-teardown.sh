#!/usr/bin/env bash
# Run after `terraform destroy` to find GreenGuard resources that still exist in
# the region, including ones whose state was lost. Exits 1 if any are found.
#   ./check-teardown.sh <region> <environment> <cluster-name>
set -euo pipefail

region="${1:?region}" environment="${2:?environment}" cluster="${3:?cluster name}"
export AWS_REGION="$region" AWS_PAGER=""
command -v aws >/dev/null || { echo "check-teardown: aws is required" >&2; exit 1; }
found=0

report() {
  local title="$1" items="$2"
  items="$(printf '%s\n' "$items" | tr '\t' '\n' | sed '/^$/d;/^None$/d')"
  [ -z "$items" ] && return
  found=1
  echo "== $title"
  echo "$items"
}

tagged() {
  aws resourcegroupstaggingapi get-resources --tag-filters "$@" \
    --query 'ResourceTagMappingList[].ResourceARN' --output text
}

exact_log_group() {
  aws logs describe-log-groups --log-group-name-prefix "$1" \
    --query "logGroups[?logGroupName=='$1'].logGroupName" --output text
}

# The tagging API can briefly list deleted resources and always lists KMS keys
# pending deletion, which are not billed; KMS is reported separately below.
report "Resources tagged Project=GreenGuard, Environment=$environment" \
  "$(tagged Key=Project,Values=GreenGuard "Key=Environment,Values=$environment" | tr '\t' '\n' | grep -v ':kms:' || true)"
report "Resources tagged kubernetes.io/cluster/$cluster" \
  "$(tagged "Key=kubernetes.io/cluster/$cluster")"
report "Resources tagged elbv2.k8s.aws/cluster=$cluster" \
  "$(tagged "Key=elbv2.k8s.aws/cluster,Values=$cluster")"
report "EKS cluster" \
  "$(aws eks list-clusters --query "clusters[?@=='$cluster']" --output text)"
report "CloudFormation stack" \
  "$(aws cloudformation describe-stacks --stack-name "GreenGuardServerless-$environment" \
      --query 'Stacks[].StackName' --output text 2>/dev/null || true)"
report "Unattached Kubernetes volumes" \
  "$(aws ec2 describe-volumes --filters Name=status,Values=available Name=tag-key,Values=kubernetes.io/created-for/pvc/name \
      --query 'Volumes[].VolumeId' --output text)"
report "Log groups" \
  "$(aws logs describe-log-groups --log-group-name-prefix "/aws/eks/$cluster" --query 'logGroups[].logGroupName' --output text)
$(exact_log_group "/aws/lambda/greenguard-escalation-mirror-$environment")
$(exact_log_group "/aws/lambda/greenguard-notification-dispatch-$environment")"
report "Unreleased Elastic IPs tagged Environment=$environment" \
  "$(aws ec2 describe-addresses --filters "Name=tag:Environment,Values=$environment" Name=tag:Project,Values=GreenGuard \
      --query 'Addresses[].AllocationId' --output text)"

for key in $(tagged Key=Project,Values=GreenGuard "Key=Environment,Values=$environment" | tr '\t' '\n' | grep ':kms:' || true); do
  state="$(aws kms describe-key --key-id "$key" --query 'KeyMetadata.KeyState' --output text 2>/dev/null || echo Unknown)"
  [ "$state" = "PendingDeletion" ] || report "KMS key not scheduled for deletion" "$key ($state)"
done

if [ "$found" -eq 0 ]; then
  echo "check-teardown: no GreenGuard resources found for $environment/$cluster in $region"
else
  echo "check-teardown: resources remain; delete them through their owner, then rerun" >&2
  exit 1
fi
