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
for tool in aws kubectl python3; do
  command -v "$tool" >/dev/null || { echo "pre-destroy: $tool is required" >&2; exit 1; }
done

actual_account="$(aws sts get-caller-identity --query Account --output text)"
if [ "$actual_account" != "$GG_ACCOUNT" ]; then
  echo "pre-destroy: AWS identity is in account $actual_account, expected $GG_ACCOUNT" >&2
  exit 1
fi

log() { echo "pre-destroy: $*"; }
pv_inventory="${GG_PV_INVENTORY_FILE:-$(dirname "$0")/.last-destroy-pvs}"
umask 077

# The EKS endpoint is private by default. Verify Kubernetes connectivity and
# admin authorization before deleting the out-of-state CDK stack or any other
# resource; otherwise a laptop without VPC/VPN access would partially tear
# down the cell before discovering it cannot remove Kubernetes-owned LBs/PVs.
stack="GreenGuardServerless-$GG_ENVIRONMENT"
stack_error="$(mktemp)"
cluster_error="$(mktemp)"
crd_error="$(mktemp)"
kubeconfig="$(mktemp)"
trap 'rm -f "$stack_error" "$cluster_error" "$crd_error" "$kubeconfig" "${pv_new:-}"' EXIT
cluster_present=false
if aws eks describe-cluster --name "$GG_CLUSTER" >/dev/null 2>"$cluster_error"; then
  cluster_present=true
  aws eks update-kubeconfig --name "$GG_CLUSTER" --kubeconfig "$kubeconfig" >/dev/null
  k() { kubectl --kubeconfig "$kubeconfig" --request-timeout=60s "$@"; }
  k get --raw=/readyz >/dev/null || {
    echo "pre-destroy: EKS API is unreachable; connect to the private endpoint before destroy" >&2
    exit 1
  }
  for kind in ingresses services statefulsets persistentvolumeclaims; do
    if [ "$(k auth can-i delete "$kind" --all-namespaces)" != yes ]; then
      echo "pre-destroy: Kubernetes identity cannot delete $kind across namespaces" >&2
      exit 1
    fi
  done
  # Stop reconciliation before CDK or PVC teardown. An API/RBAC failure must
  # not masquerade as an absent Argo CRD.
  argo_present=false
  if k get crd applications.argoproj.io >/dev/null 2>"$crd_error"; then
    argo_present=true
  elif ! grep -q 'NotFound' "$crd_error"; then
    cat "$crd_error" >&2
    echo "pre-destroy: cannot determine whether Argo Applications exist" >&2
    exit 1
  fi
  if [ "$argo_present" = true ]; then
    if [ "$(k auth can-i delete applications.argoproj.io --all-namespaces)" != yes ]; then
      echo "pre-destroy: Kubernetes identity cannot delete Argo Applications" >&2
      exit 1
    fi
  fi
fi

# Exercise every final inventory read before mutating either owner. A denied
# global or regional listing must stop while the cell is still intact.
"$(dirname "$0")/check-teardown.sh" --preflight "$GG_REGION" "$GG_ENVIRONMENT" "$GG_CLUSTER" "$GG_ACCOUNT" "${GG_MASTER_SECRET_ARN:-}" "$pv_inventory"

# Simulate the AWS deletes this hook performs. This catches missing identity
# policy permissions before the first CloudFormation or Kubernetes mutation.
# AWS Organizations controls and resource policies are still enforced by the
# actual delete calls, so a later denial remains a resumable failure.
caller_arn="$(aws sts get-caller-identity --query Arn --output text)"
if [[ "$caller_arn" =~ ^arn:([^:]+):sts::([0-9]{12}):assumed-role/([^/]+)/ ]]; then
  principal_arn="arn:${BASH_REMATCH[1]}:iam::${BASH_REMATCH[2]}:role/${BASH_REMATCH[3]}"
elif [[ "$caller_arn" =~ ^arn:[^:]+:iam::[0-9]{12}:(role|user)/ ]]; then
  principal_arn="$caller_arn"
else
  echo "pre-destroy: cannot resolve an IAM principal for delete permission preflight" >&2
  exit 1
fi
denied="$(aws iam simulate-principal-policy --policy-source-arn "$principal_arn" \
  --action-names cloudformation:DeleteStack logs:DeleteLogGroup \
  --resource-arns '*' --query 'EvaluationResults[?EvalDecision!=`allowed`].EvalActionName' --output text)" || {
  echo "pre-destroy: AWS delete permission simulation failed" >&2
  exit 1
}
if [ -n "$denied" ] && [ "$denied" != None ]; then
  echo "pre-destroy: AWS delete permissions denied: $denied" >&2
  exit 1
fi

if [ "$cluster_present" = true ]; then
  if [ "$argo_present" = true ]; then
    log "deleting this cell's Argo Applications before other resources"
    k delete applications.argoproj.io --all-namespaces -l "greenguard.io/cell=$GG_CLUSTER" --wait=true --timeout=10m
    # An unlabeled Application targeting GreenGuard could recreate claims.
    # Refuse teardown instead of deleting another owner's Application.
    k get applications.argoproj.io --all-namespaces -o json | python3 -c '
import json, sys
for app in json.load(sys.stdin).get("items", []):
    spec = app.get("spec", {})
    targets = [spec.get("destination", {})] + spec.get("destinations", [])
    if any(t.get("namespace") == "greenguard" for t in targets):
        name = app.get("metadata", {}).get("name", "<unknown>")
        raise SystemExit(f"pre-destroy: Argo Application {name} still targets greenguard; reconcile/delete its owner first")
'
  fi
elif grep -q 'ResourceNotFoundException' "$cluster_error"; then
  log "cluster $GG_CLUSTER not found; skipping Kubernetes cleanup"
  # A failed apply before EKS has no Kubernetes PVs to capture. Persist an
  # empty inventory so the final check can distinguish this case from a lost
  # inventory after a cluster existed. Preserve any IDs from an earlier run.
  if [ ! -e "$pv_inventory" ]; then
    : >"$pv_inventory"
  fi
else
  cat "$cluster_error" >&2
  exit 1
fi

# 1. CDK serverless stack for this environment (see infra/cdk/app.py).
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
if [ "$cluster_present" = true ]; then
  # Save exact EBS volume IDs while PV claim references still exist. This
  # disposable cluster's PVC cleanup spans every namespace, so its inventory
  # must cover every EBS PV, including released claims and controller namespaces.
  # Keep IDs captured by a previous attempt: its PVCs may already be gone.
  pv_new="$(mktemp "${pv_inventory}.XXXXXX")"
  k get pv -o json | python3 -c '
import json, re, sys
data = json.load(sys.stdin)
for pv in data.get("items", []):
    spec = pv.get("spec", {})
    if spec.get("csi", {}).get("driver") != "ebs.csi.aws.com":
        continue
    volume_id = spec["csi"].get("volumeHandle", "")
    if not re.fullmatch(r"vol-[0-9a-f]+", volume_id):
        raise SystemExit("pre-destroy: invalid EBS volume ID on a GreenGuard PV")
    print(volume_id)
' >"$pv_new"
  if [ -f "$pv_inventory" ]; then cat "$pv_inventory" >>"$pv_new"; fi
  sort -u "$pv_new" >"$pv_inventory"
  rm -f "$pv_new"
  pv_new=""
  log "deleting ingresses"
  k delete ingress --all --all-namespaces --wait=true --timeout=10m
  log "deleting LoadBalancer services"
  k get service --all-namespaces \
    -o jsonpath='{range .items[?(@.spec.type=="LoadBalancer")]}{.metadata.namespace}{" "}{.metadata.name}{"\n"}{end}' |
    while read -r namespace name; do
      [ -n "$name" ] && k delete service -n "$namespace" "$name" --wait=true --timeout=10m
    done
  # Stop disposable data writers before removing their RWO claims. GitOps
  # reconciliation must already be disabled so it cannot recreate them.
  log "deleting disposable data StatefulSets"
  k delete statefulset -n greenguard redis-cluster rabbitmq kafka --ignore-not-found --wait=true --timeout=10m
  log "deleting persistent volume claims"
  k delete pvc --all --all-namespaces --wait=true --timeout=10m
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
