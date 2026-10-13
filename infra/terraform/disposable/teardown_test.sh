#!/usr/bin/env bash
# Offline tests for pre-destroy.sh and check-teardown.sh. Stub `aws` and
# `kubectl` record every call and answer from files, so no AWS account is used.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
pass=0

cat >"$work/aws" <<'EOF'
#!/usr/bin/env bash
echo "aws $*" >>"$STUB_DIR/calls"
case "$1 $2" in
  "sts get-caller-identity")
    if [[ "$*" == *"--query Arn"* ]]; then echo 'arn:aws:sts::123456789012:assumed-role/greenguard-operator/test'
    else cat "$STUB_DIR/account" 2>/dev/null || echo 123456789012; fi ;;
  "iam simulate-principal-policy")
    if [ -f "$STUB_DIR/delete_denied" ]; then echo cloudformation:DeleteStack; fi ;;
  "cloudformation describe-stacks") [ -f "$STUB_DIR/stack" ] && { cat "$STUB_DIR/stack"; exit 0; }
    echo "An error occurred (ValidationError): Stack with id x does not exist" >&2; exit 254 ;;
  "cloudformation delete-stack") rm -f "$STUB_DIR/stack" ;;
  "eks describe-cluster") [ -f "$STUB_DIR/cluster" ] || { echo "An error occurred (ResourceNotFoundException)" >&2; exit 254; } ;;
  "eks list-clusters") [ -f "$STUB_DIR/cluster" ] && echo greenguard-sandbox-cell-1 ;;
  "logs describe-log-groups")
    query=""
    for arg in "$@"; do
      case "$arg" in "logGroups[?logGroupName=="*) query="$arg" ;; esac
    done
    if [ -n "$query" ]; then
      wanted="${query#*==\'}"
      wanted="${wanted%%\'*}"
      grep -Fx "$wanted" "$STUB_DIR/logs" 2>/dev/null || true
    elif [[ "$*" == *"/aws/eks/"* ]]; then
      grep '^/aws/eks/' "$STUB_DIR/logs" 2>/dev/null || true
    else
      cat "$STUB_DIR/logs" 2>/dev/null || true
    fi ;;
  "logs delete-log-group") grep -Fvx -- "$4" "$STUB_DIR/logs" >"$STUB_DIR/logs.next" || true
    mv "$STUB_DIR/logs.next" "$STUB_DIR/logs" ;;
  "resourcegroupstaggingapi get-resources")
    if [ -f "$STUB_DIR/tagging_error" ]; then
      echo "AccessDenied: tagging inventory unavailable" >&2
      exit 254
    fi
    if [[ "$*" == *elasticloadbalancing* ]]; then
      n=$(cat "$STUB_DIR/lb_polls" 2>/dev/null || echo 0)
      if [ "$n" -gt 0 ]; then echo "arn:aws:elasticloadbalancing:r:1:loadbalancer/net/k8s/1"; echo $((n - 1)) >"$STUB_DIR/lb_polls"; fi
    else
      cat "$STUB_DIR/tagged" 2>/dev/null || true
    fi ;;
  "ec2 describe-volumes") cat "$STUB_DIR/volumes" 2>/dev/null || true ;;
  "ec2 describe-vpcs") cat "$STUB_DIR/cell_vpcs" 2>/dev/null || true ;;
  "ec2 describe-internet-gateways") cat "$STUB_DIR/cell_igws" 2>/dev/null || true ;;
  "ec2 describe-nat-gateways") cat "$STUB_DIR/cell_nat_gateways" 2>/dev/null || true ;;
  "ec2 describe-addresses")
    if [[ "$*" == *"Name=tag:Name"* ]]; then cat "$STUB_DIR/cell_nat_eips" 2>/dev/null || true
    else cat "$STUB_DIR/elastic_ips" 2>/dev/null || true; fi ;;
  "rds describe-db-instances")
    if [ -f "$STUB_DIR/rds_error" ]; then
      echo 'An error occurred (AccessDenied)' >&2; exit 254
    fi
    if [ -f "$STUB_DIR/rds_missing" ] && [[ "$*" == *--db-instance-identifier* ]]; then
      echo 'An error occurred (DBInstanceNotFound)' >&2; exit 254
    fi
    if [[ "$*" == *starts_with* ]]; then cat "$STUB_DIR/shard_instances" 2>/dev/null || true; else cat "$STUB_DIR/rds_instances" 2>/dev/null || true; fi ;;
  "rds describe-db-snapshots") if [[ "$*" == *starts_with* ]]; then cat "$STUB_DIR/shard_snapshots" 2>/dev/null || true; else cat "$STUB_DIR/rds_snapshots" 2>/dev/null || true; fi ;;
  "dynamodb describe-table")
    if [ -f "$STUB_DIR/dynamodb_error" ]; then echo 'An error occurred (AccessDeniedException)' >&2; exit 254; fi
    if [ -f "$STUB_DIR/notification_state_table" ]; then cat "$STUB_DIR/notification_state_table"; else
      echo 'An error occurred (ResourceNotFoundException)' >&2; exit 254
    fi ;;
  "s3api list-buckets") cat "$STUB_DIR/s3_buckets" 2>/dev/null || true ;;
  "ecr describe-repositories")
    if [ -f "$STUB_DIR/ecr_error" ]; then echo 'AccessDenied: ECR inventory unavailable' >&2; exit 254; fi
    if [[ "$*" != *"starts_with(repositoryName, 'greenguard/sandbox/cell-"* ]]; then
      echo 'ECR inventory must be scoped to Terraform-owned GreenGuard repositories' >&2; exit 254
    fi
    arguments="$*"
    prefix="${arguments#*starts_with(repositoryName, \'}"
    prefix="${prefix%%\'*}"
    grep "^${prefix}" "$STUB_DIR/ecr_repositories" 2>/dev/null || true ;;
  "secretsmanager list-secrets")
    if [ -f "$STUB_DIR/customer_secrets_error" ]; then echo 'AccessDenied: Secrets Manager inventory unavailable' >&2; exit 254; fi
    if [[ "$*" != *"--include-planned-deletion"* || "$*" != *"starts_with(Name, 'greenguard/sandbox/')"* ]]; then
      echo 'Secrets Manager inventory must be scoped to the requested environment' >&2; exit 254
    fi
    cat "$STUB_DIR/customer_secret_arns" 2>/dev/null || true ;;
  "elbv2 describe-load-balancers") cat "$STUB_DIR/edge_alb" 2>/dev/null || true ;;
  "cloudfront list-distributions")
    if [ -f "$STUB_DIR/edge_inventory_error" ]; then echo 'AccessDenied: CloudFront inventory unavailable' >&2; exit 254; fi
    if [[ "$*" == *"dashboard"* ]]; then cat "$STUB_DIR/web_distribution" 2>/dev/null || true
    else cat "$STUB_DIR/api_distribution" 2>/dev/null || true; fi ;;
  "cloudfront list-vpc-origins") cat "$STUB_DIR/vpc_origin" 2>/dev/null || true ;;
  "wafv2 list-web-acls") cat "$STUB_DIR/edge_waf" 2>/dev/null || true ;;
  "cognito-idp list-user-pools")
    if [[ "$*" != *"--max-results 60"* || "$*" == *"--page-size"* ]]; then
      echo 'Cognito inventory must provide the required service MaxResults parameter' >&2; exit 254
    fi
    cat "$STUB_DIR/cognito_pool" 2>/dev/null || true ;;
  "cognito-idp describe-user-pool-domain")
    if [ -f "$STUB_DIR/cognito_domain_missing" ]; then
      echo "An error occurred (ResourceNotFoundException)" >&2; exit 254
    fi
    cat "$STUB_DIR/cognito_domain" 2>/dev/null || true ;;
  "secretsmanager describe-secret")
    if [ -f "$STUB_DIR/master_secret" ]; then cat "$STUB_DIR/master_secret"; else
      echo "An error occurred (ResourceNotFoundException)" >&2; exit 254
    fi ;;
  "ec2 describe-instances")
    if [ -f "$STUB_DIR/ec2_error" ]; then echo 'UnauthorizedOperation: EC2 inventory unavailable' >&2; exit 254; fi
    if [[ "$*" != *"Name=tag:kubernetes.io/cluster/greenguard-sandbox-cell-1,Values=owned"* || "$*" != *"Name=tag-key,Values=karpenter.sh/nodepool"* || "$*" != *"shutting-down"* ]]; then
      echo 'Karpenter instance inventory must be scoped to this cluster and include instances still shutting down' >&2; exit 254
    fi
    n=$(cat "$STUB_DIR/karpenter_instance_polls" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then cat "$STUB_DIR/karpenter_instances"; echo $((n - 1)) >"$STUB_DIR/karpenter_instance_polls"; fi ;;
  "ec2 describe-launch-templates")
    if [ -f "$STUB_DIR/karpenter_template_error" ]; then echo 'UnauthorizedOperation: launch template inventory unavailable' >&2; exit 254; fi
    python3 - "$STUB_DIR/karpenter_launch_templates.json" "$@" <<'PYMOCK'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
records = json.loads(path.read_text()).get("LaunchTemplates", []) if path.exists() else []
filters = []
for argument in sys.argv[2:]:
    if argument.startswith("Name="):
        fields = dict(field.split("=", 1) for field in argument.split(",", 1))
        filters.append((fields["Name"], fields["Values"].split(",")))
def matches(record):
    tags = {tag["Key"]: tag["Value"] for tag in record.get("Tags", [])}
    for name, values in filters:
        if name.startswith("tag:"):
            if tags.get(name[4:]) not in values: return False
        elif name == "tag-key":
            if not any(value in tags for value in values): return False
        else:
            raise SystemExit("unsupported EC2 launch template filter")
    return True
print("\t".join(record["LaunchTemplateId"] for record in records if matches(record)))
PYMOCK
    ;;
  "ec2 delete-launch-template")
    python3 - "$STUB_DIR/karpenter_launch_templates.json" "$4" <<'PYMOCK'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
document = json.loads(path.read_text())
document["LaunchTemplates"] = [record for record in document["LaunchTemplates"] if record["LaunchTemplateId"] != sys.argv[2]]
path.write_text(json.dumps(document))
PYMOCK
    ;;
  "sqs list-queues") cat "$STUB_DIR/karpenter_queues" 2>/dev/null || true ;;
  "events list-rules") cat "$STUB_DIR/karpenter_rules" 2>/dev/null || true ;;
  "iam list-instance-profiles") cat "$STUB_DIR/karpenter_instance_profiles" 2>/dev/null || true ;;
  "kms describe-key")
    if [ -f "$STUB_DIR/kms_error" ]; then echo 'AccessDenied: KMS inventory unavailable' >&2; exit 254; fi
    echo PendingDeletion ;;
esac
exit 0
EOF
cat >"$work/kubectl" <<'EOF'
#!/usr/bin/env bash
echo "kubectl $*" >>"$STUB_DIR/calls"
if [[ "$*" == *"get --raw=/readyz"* ]] && [ -f "$STUB_DIR/api_unreachable" ]; then exit 1; fi
if [[ "$*" == *"auth can-i"* ]]; then echo yes; exit 0; fi
if [[ "$*" == *"get crd applications.argoproj.io"* ]]; then
  if [ -f "$STUB_DIR/argo_crd_error" ]; then
    echo 'Error from server (Forbidden): applications.argoproj.io' >&2; exit 1
  fi
  if [ -f "$STUB_DIR/argo_crd_absent" ]; then
    echo 'Error from server (NotFound): applications.argoproj.io' >&2; exit 1
  fi
  exit 0
fi
if [[ "$*" == *"get crd nodepools.karpenter.sh"* ]]; then
  if [ -f "$STUB_DIR/karpenter_crd_error" ]; then
    echo 'Error from server (Forbidden): nodepools.karpenter.sh' >&2; exit 1
  fi
  if [ -f "$STUB_DIR/karpenter_crd_absent" ]; then
    echo 'Error from server (NotFound): nodepools.karpenter.sh' >&2; exit 1
  fi
  exit 0
fi
if [[ "$*" == *"delete nodepools.karpenter.sh"* ]] && [ -f "$STUB_DIR/karpenter_delete_stuck" ]; then
  echo 'error: timed out waiting for the condition on nodepools/greenguard-compute' >&2; exit 1
fi
if [[ "$*" == *"get applications.argoproj.io --all-namespaces -o json"* ]]; then
  cat "$STUB_DIR/argo_apps" 2>/dev/null || echo '{"items":[]}'
  exit 0
fi
if [[ "$*" == *"get pv -o json"* ]]; then
  cat "$STUB_DIR/pvs" 2>/dev/null || echo '{"items":[]}'
  exit 0
fi
[[ "$*" == *"get service"* ]] && printf 'ingress-nginx edge\n'
exit 0
EOF
cat >"$work/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$work/terraform" <<'EOF'
#!/usr/bin/env bash
echo "terraform $*" >>"$STUB_DIR/calls"
[ "$1" = output ] && {
  [ -f "$STUB_DIR/output_error" ] && { echo 'State read failed' >&2; exit 1; }
  identity="$(cat "$STUB_DIR/identity" 2>/dev/null || printf '%s\n' '{"region":"us-east-1","environment":"sandbox","cluster_name":"greenguard-sandbox-cell-1","account_id":"123456789012"}')"
  if [ -f "$STUB_DIR/identity_error" ]; then
    printf '%s\n' '{}'; exit 0
  fi
  if [ -f "$STUB_DIR/shard_output" ]; then
    printf '{"disposable_cell_identity":{"value":%s},"postgres_shards":{"value":%s}}\n' "$identity" "$(cat "$STUB_DIR/shard_output")"
  elif [ -f "$STUB_DIR/master_secret_output" ]; then
    secret="$(cat "$STUB_DIR/master_secret_output")"
    printf '{"disposable_cell_identity":{"value":%s},"postgres_master_secret_arn":{"value":"%s"}}\n' "$identity" "$secret"
  else
    printf '{"disposable_cell_identity":{"value":%s}}\n' "$identity"
  fi
  exit 0
}
[ "$1" = show ] && { cat "$STUB_DIR/show_state" 2>/dev/null || printf '%s\n' '{}'; exit 0; }
[ "$1" = destroy ] && {
  [ "${GG_VERIFIED_DESTROY_SCOPE:-}" = "123456789012:us-east-1:sandbox:greenguard-sandbox-cell-1" ] || exit 91
  [ ! -f "$STUB_DIR/terraform_error" ] && { rm -f "$STUB_DIR/cluster"; exit 0; }
}
[ ! -f "$STUB_DIR/terraform_error" ]
EOF
chmod +x "$work/aws" "$work/kubectl" "$work/sleep" "$work/terraform"

setup() {
  export STUB_DIR="$work/$1"
  mkdir -p "$STUB_DIR"
  export PATH="$work:$PATH"
  export GG_PV_INVENTORY_FILE="$STUB_DIR/pv-ids"
  : >"$GG_PV_INVENTORY_FILE"
}
# Model actual pinned v1.15 tags. The generic EC2 stub applies the supplied
# filters to these records rather than assuming that any one selector is right.
template_fixture() {
  python3 - "$STUB_DIR/karpenter_launch_templates.json" "${1:-owned}" <<'PYFIXTURE'
import json, sys
cell = "greenguard-sandbox-cell-1"
def template(identifier, tags):
    return {"LaunchTemplateId": identifier, "Tags": [{"Key": key, "Value": value} for key, value in tags.items()]}
owned_tags = {"eks:eks-cluster-name": cell, f"kubernetes.io/cluster/{cell}": "owned", "karpenter.sh/nodepool": "greenguard-compute", "karpenter.k8s.aws/ec2nodeclass": "greenguard-disposable"}
owned = template("lt-0abc1234", owned_tags)
negative = [
    template("lt-0bbb2222", {"eks:eks-cluster-name": "neighbor", "kubernetes.io/cluster/neighbor": "owned", "karpenter.sh/nodepool": "neighbor", "karpenter.k8s.aws/ec2nodeclass": "neighbor"}),
    template("lt-0ccc3333", {"eks:eks-cluster-name": cell, f"kubernetes.io/cluster/{cell}": "owned"}),
    template("lt-0ddd4444", dict(owned_tags, **{f"kubernetes.io/cluster/{cell}": "shared"})),
    template("lt-0eee5555", dict(owned_tags, **{"eks:eks-cluster-name": "neighbor"})),
    template("lt-0fff6666", {"karpenter.k8s.aws/cluster": cell, "karpenter.sh/nodepool": "legacy"}),
]
records = [owned] if sys.argv[2] == "owned" else negative if sys.argv[2] == "negatives" else [owned] + negative
with open(sys.argv[1], "w") as output: json.dump({"LaunchTemplates": records}, output)
PYFIXTURE
}
ok() { pass=$((pass + 1)); echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; cat "$STUB_DIR/out" >&2 2>/dev/null || true; cat "$STUB_DIR/calls" >&2 2>/dev/null || true; exit 1; }
run_pre() {
  GG_PV_INVENTORY_FILE="$STUB_DIR/pv-ids" GG_CLUSTER=greenguard-sandbox-cell-1 GG_REGION=us-east-1 GG_ENVIRONMENT="${1:-sandbox}" GG_ACCOUNT=123456789012 \
    GG_WAIT_SECONDS="${2:-900}" GG_DESTROY_INVENTORY_SENTINEL_ENABLED="${3:-true}" \
    GG_VERIFIED_DESTROY_SCOPE="${4:-}" "$here/pre-destroy.sh" >"$STUB_DIR/out" 2>&1
}

setup prod
if run_pre prod; then fail "prod is refused"; fi
grep -q "refusing" "$STUB_DIR/out" && [ ! -f "$STUB_DIR/calls" ] && ok "prod is refused before any AWS call" || fail "prod is refused before any AWS call assertions"
if run_pre production; then fail "production is refused"; fi
grep -q "refusing" "$STUB_DIR/out" && [ ! -f "$STUB_DIR/calls" ] && ok "production alias is refused before any AWS call" || fail "production alias is refused before any AWS call assertions"

setup legacy-raw-destroy
if run_pre sandbox 900 false; then fail "legacy raw destroy must be blocked without the final inventory sentinel"; fi
grep -q 'state has no final-inventory sentinel' "$STUB_DIR/out" && [ ! -f "$STUB_DIR/calls" ] &&
  ok "legacy raw destroy without final inventory sentinel is refused before AWS calls" || fail "legacy raw destroy without final inventory sentinel is refused before AWS calls assertions"

setup legacy-verified-destroy
run_pre sandbox 900 false '123456789012:us-east-1:sandbox:greenguard-sandbox-cell-1' || fail "exact verified wrapper scope should authorize the legacy cleanup path"
grep -q 'inventory read permissions verified' "$STUB_DIR/out" && [ -f "$STUB_DIR/calls" ] &&
  ok "exact verified wrapper scope authorizes legacy cleanup with mocked AWS" || fail "exact verified wrapper scope authorizes legacy cleanup with mocked AWS assertions"

setup production-inventory
if "$here/check-teardown.sh" us-east-1 production greenguard-production 123456789012 >"$STUB_DIR/out" 2>&1; then fail "production inventory is refused"; fi
grep -q "refusing production" "$STUB_DIR/out" && [ ! -f "$STUB_DIR/calls" ] && ok "production inventory is refused before any AWS call" || fail "production inventory is refused before any AWS call assertions"

setup full
echo GreenGuardServerless-sandbox >"$STUB_DIR/stack"
touch "$STUB_DIR/cluster"
echo 2 >"$STUB_DIR/lb_polls"
printf '/aws/lambda/greenguard-escalation-mirror-sandbox\n/aws/lambda/greenguard-notification-dispatch-sandbox\n' >"$STUB_DIR/logs"
run_pre || fail "full cleanup succeeds"
calls="$STUB_DIR/calls"
grep -q "cloudformation delete-stack --stack-name GreenGuardServerless-sandbox" "$calls" || fail "CDK stack deleted"
grep -q "cloudformation wait stack-delete-complete" "$calls" || fail "waits for stack deletion"
grep -q "logs delete-log-group --log-group-name /aws/lambda/greenguard-escalation-mirror-sandbox" "$calls" || fail "mirror log group deleted"
grep -q "logs delete-log-group --log-group-name /aws/lambda/greenguard-notification-dispatch-sandbox" "$calls" || fail "dispatch log group deleted"
grep -q "kubectl .*delete ingress --all" "$calls" || fail "ingresses deleted"
grep -q "kubectl .*delete service -n ingress-nginx edge" "$calls" || fail "LoadBalancer service deleted"
grep -q "kubectl .*delete applications.argoproj.io --all-namespaces -l greenguard.io/cell=greenguard-sandbox-cell-1" "$calls" || fail "only this cell's Argo Applications deleted"
grep -q "kubectl .*delete statefulset -n greenguard redis-cluster rabbitmq" "$calls" || fail "disposable data StatefulSets stopped"
grep -q "kubectl .*delete pvc --all" "$calls" || fail "PVCs deleted"
[ "$(grep -c elasticloadbalancing "$calls")" -ge 4 ] || fail "polls until load balancers are gone"
ok "deletes CDK stack, Kubernetes LB owners and PVCs, then waits for load balancers" || fail "deletes CDK stack, Kubernetes LB owners and PVCs, then waits for load balancers assertions"
grep -q "kubectl .*delete nodepools.karpenter.sh --all" "$calls" || fail "Karpenter NodePools deleted"
grep -q "kubectl .*delete nodeclaims.karpenter.sh --all" "$calls" || fail "Karpenter NodeClaims deleted"
pvc_line="$(grep -n 'delete pvc --all' "$calls" | head -1 | cut -d: -f1)"
nodepool_line="$(grep -n 'delete nodepools.karpenter.sh --all' "$calls" | head -1 | cut -d: -f1)"
instance_line="$(grep -n 'aws ec2 describe-instances' "$calls" | tail -1 | cut -d: -f1)"
lb_line="$(grep -n 'elasticloadbalancing' "$calls" | tail -1 | cut -d: -f1)"
[ "$pvc_line" -lt "$nodepool_line" ] && [ "$nodepool_line" -lt "$instance_line" ] && [ "$instance_line" -lt "$lb_line" ] ||
  fail "Karpenter capacity is removed after workloads and before the network wait"
! grep -q 'ec2 terminate-instances' "$calls" || fail "no direct termination when Karpenter removed its own nodes"
ok "deletes Karpenter NodePools after workloads and confirms no instance remains from the AWS API" || fail "deletes Karpenter NodePools after workloads and confirms no instance remains from the AWS API assertions"

setup karpenter-orphaned-instances
touch "$STUB_DIR/cluster"
# One read by the preflight inventory, then two by cleanup before they are gone.
printf 'i-0aaa1111\ti-0bbb2222\n' >"$STUB_DIR/karpenter_instances"
echo 3 >"$STUB_DIR/karpenter_instance_polls"
template_fixture
run_pre || fail "orphaned Karpenter instances should be terminated"
grep -q 'aws ec2 terminate-instances --instance-ids i-0aaa1111 i-0bbb2222' "$STUB_DIR/calls" || fail "both Karpenter instances terminated"
grep -q 'aws ec2 delete-launch-template --launch-template-id lt-0abc1234' "$STUB_DIR/calls" || fail "Karpenter launch template deleted"
grep -q 'waiting for Karpenter instances to terminate' "$STUB_DIR/out" &&
  ok "instances that outlive their NodePools are terminated and awaited, then launch templates are deleted" || fail "instances that outlive their NodePools are terminated and awaited, then launch templates are deleted assertions"

setup karpenter-orphans-without-cluster
printf 'i-0ccc3333\n' >"$STUB_DIR/karpenter_instances"
echo 2 >"$STUB_DIR/karpenter_instance_polls"
run_pre || fail "Karpenter instances must be removed even when EKS is already gone"
grep -q 'aws ec2 terminate-instances --instance-ids i-0ccc3333' "$STUB_DIR/calls" &&
  ! grep -q kubectl "$STUB_DIR/calls" && ok "Karpenter instances are terminated from the AWS API when the cluster no longer exists" || fail "Karpenter instances are terminated from the AWS API when the cluster no longer exists assertions"

setup karpenter-instance-stuck
printf 'i-0ddd4444\n' >"$STUB_DIR/karpenter_instances"
echo 999 >"$STUB_DIR/karpenter_instance_polls"
if run_pre sandbox 0; then fail "an instance that never terminates must fail the destroy"; fi
grep -q 'Karpenter instances still present' "$STUB_DIR/out" && grep -q 'i-0ddd4444' "$STUB_DIR/out" &&
  ok "a Karpenter instance that never terminates stops the destroy" || fail "a Karpenter instance that never terminates stops the destroy assertions"

setup karpenter-invalid-instance-id
printf 'i-0eee5555 --dry-run\n' >"$STUB_DIR/karpenter_instances"
echo 999 >"$STUB_DIR/karpenter_instance_polls"
if run_pre; then fail "unexpected EC2 inventory text must not reach terminate-instances"; fi
grep -q 'invalid Karpenter instance ID' "$STUB_DIR/out" && ! grep -q 'ec2 terminate-instances' "$STUB_DIR/calls" &&
  ok "malformed instance inventory is refused before any termination" || fail "malformed instance inventory is refused before any termination assertions"

setup karpenter-crd-forbidden
touch "$STUB_DIR/cluster" "$STUB_DIR/stack" "$STUB_DIR/karpenter_crd_error"
if run_pre; then fail "Karpenter CRD API/RBAC failure must stop destroy"; fi
grep -q 'cannot determine whether Karpenter NodePools exist' "$STUB_DIR/out" &&
  ! grep -q 'cloudformation delete-stack\|--request-timeout=60s delete' "$STUB_DIR/calls" && ok "Karpenter CRD errors fail before destructive cleanup" || fail "Karpenter CRD errors fail before destructive cleanup assertions"

setup karpenter-crd-absent
touch "$STUB_DIR/cluster" "$STUB_DIR/karpenter_crd_absent"
run_pre || fail "absent Karpenter CRD should allow remaining cleanup"
! grep -q 'delete nodepools.karpenter.sh' "$STUB_DIR/calls" && grep -q 'aws ec2 describe-instances' "$STUB_DIR/calls" &&
  ok "absent Karpenter CRD skips NodePool deletion but still inventories EC2" || fail "absent Karpenter CRD skips NodePool deletion but still inventories EC2 assertions"

setup karpenter-nodepool-delete-stuck
touch "$STUB_DIR/cluster" "$STUB_DIR/karpenter_delete_stuck"
printf 'i-0fff6666\n' >"$STUB_DIR/karpenter_instances"
echo 3 >"$STUB_DIR/karpenter_instance_polls"
if run_pre; then fail "undeletable NodePools must fail the destroy"; fi
grep -q 'aws ec2 terminate-instances --instance-ids i-0fff6666' "$STUB_DIR/calls" &&
  grep -q 'could not be deleted' "$STUB_DIR/out" &&
  ok "a broken Karpenter controller still gets its instances terminated, then stops the destroy" || fail "a broken Karpenter controller still gets its instances terminated, then stops the destroy assertions"

setup karpenter-inventory-denied
touch "$STUB_DIR/stack" "$STUB_DIR/ec2_error"
if run_pre; then fail "EC2 instance inventory denial must stop before mutations"; fi
! grep -q 'cloudformation delete-stack\|logs delete-log-group' "$STUB_DIR/calls" && ok "EC2 instance inventory denial stops before AWS cleanup" || fail "EC2 instance inventory denial stops before AWS cleanup assertions"

setup karpenter-leftovers
printf 'i-0aaa1111\n' >"$STUB_DIR/karpenter_instances"
echo 999 >"$STUB_DIR/karpenter_instance_polls"
template_fixture
echo https://sqs.us-east-1.amazonaws.com/123456789012/greenguard-sandbox-cell-1-e3b0c442-kp >"$STUB_DIR/karpenter_queues"
echo greenguard-sandbox-cell-1-e3b0c442-kp-state >"$STUB_DIR/karpenter_rules"
echo greenguard-sandbox-cell-1-e3b0c442-kp-node >"$STUB_DIR/karpenter_instance_profiles"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "Karpenter leftovers must fail the final inventory"; fi
grep -q 'Karpenter-launched EC2 instances not terminated' "$STUB_DIR/out" && grep -q 'i-0aaa1111' "$STUB_DIR/out" &&
  grep -q 'lt-0abc1234' "$STUB_DIR/out" && grep -q 'Karpenter interruption queue' "$STUB_DIR/out" &&
  grep -q 'kp-state' "$STUB_DIR/out" && grep -q 'kp-node' "$STUB_DIR/out" &&
  ok "final inventory reports Karpenter instances, launch templates, queue, rules and instance profile" || fail "final inventory reports Karpenter instances, launch templates, queue, rules and instance profile assertions"
expected_prefix="greenguard-sandbox-cell-1-$(printf '%s' greenguard-sandbox-cell-1 | shasum -a 256 | cut -c1-8)-kp"
grep -q "aws sqs list-queues --queue-name-prefix $expected_prefix " "$STUB_DIR/calls" &&
  grep -q "aws events list-rules --name-prefix $expected_prefix- " "$STUB_DIR/calls" &&
  ok "final inventory derives the same Karpenter name prefix as Terraform" || fail "final inventory derives the same Karpenter name prefix as Terraform assertions"

setup argo-crd-forbidden
touch "$STUB_DIR/cluster" "$STUB_DIR/stack" "$STUB_DIR/argo_crd_error"
if run_pre; then fail "Argo CRD API/RBAC failure must stop destroy"; fi
grep -q 'cannot determine whether Argo Applications exist' "$STUB_DIR/out" &&
  ! grep -q 'cloudformation delete-stack\|delete pvc' "$STUB_DIR/calls" && ok "Argo CRD errors fail before destructive cleanup" || fail "Argo CRD errors fail before destructive cleanup assertions"

setup argo-unlabeled-app
touch "$STUB_DIR/cluster" "$STUB_DIR/stack"
printf '%s\n' '{"items":[{"metadata":{"name":"unlabeled"},"spec":{"destination":{"namespace":"greenguard"}}}]}' >"$STUB_DIR/argo_apps"
if run_pre; then fail "unowned Argo Application targeting greenguard must stop destroy"; fi
grep -q 'Argo Application unlabeled still targets greenguard' "$STUB_DIR/out" &&
  ! grep -q 'cloudformation delete-stack\|delete pvc' "$STUB_DIR/calls" && ok "unlabeled GreenGuard Argo Application blocks before CDK cleanup" || fail "unlabeled GreenGuard Argo Application blocks before CDK cleanup assertions"

setup argo-crd-absent
touch "$STUB_DIR/cluster" "$STUB_DIR/argo_crd_absent"
run_pre || fail "absent Argo CRD should allow remaining cleanup"
! grep -q 'delete applications.argoproj.io' "$STUB_DIR/calls" && ok "absent Argo CRD skips Argo cleanup" || fail "absent Argo CRD skips Argo cleanup assertions"

setup nothing
run_pre || fail "no stack and no cluster is a clean no-op"
! grep -q "delete-stack\|kubectl" "$STUB_DIR/calls" && ok "skips stack and Kubernetes cleanup when absent" || fail "skips stack and Kubernetes cleanup when absent assertions"

setup preserved-pv-inventory
echo vol-1234abcd >"$GG_PV_INVENTORY_FILE"
run_pre || fail "missing cluster with saved PV inventory should preserve the IDs"
grep -Fxq vol-1234abcd "$GG_PV_INVENTORY_FILE" && ok "retry after EKS deletion retains exact EBS PV IDs" || fail "retry after EKS deletion retains exact EBS PV IDs assertions"

setup absent-cluster-empty-pv-inventory
rm "$GG_PV_INVENTORY_FILE"
run_pre || fail "absent EKS should establish an empty PV inventory"
[ -f "$GG_PV_INVENTORY_FILE" ] && [ ! -s "$GG_PV_INVENTORY_FILE" ] &&
  ok "pre-EKS cleanup records an empty PV inventory" || fail "pre-EKS cleanup records an empty PV inventory assertions"

setup preserved-pv-after-pvc-deletion
touch "$STUB_DIR/cluster"
echo vol-1234abcd >"$GG_PV_INVENTORY_FILE"
run_pre || fail "retry with deleted PVCs should preserve captured EBS IDs"
grep -Fxq vol-1234abcd "$GG_PV_INVENTORY_FILE" && ok "retry with remaining EKS merges saved PV IDs" || fail "retry with remaining EKS merges saved PV IDs assertions"

setup all-namespace-pv-inventory
touch "$STUB_DIR/cluster"
printf '%s\n' '{"items":[{"spec":{"csi":{"driver":"ebs.csi.aws.com","volumeHandle":"vol-1111aaaa"},"claimRef":{"namespace":"greenguard"}}},{"spec":{"csi":{"driver":"ebs.csi.aws.com","volumeHandle":"vol-2222bbbb"},"claimRef":{"namespace":"monitoring"}}},{"spec":{"csi":{"driver":"ebs.csi.aws.com","volumeHandle":"vol-3333cccc"}}}]}' >"$STUB_DIR/pvs"
run_pre || fail "all claimed EBS PVs should be captured before deleting all namespaces' PVCs"
grep -Fxq vol-1111aaaa "$GG_PV_INVENTORY_FILE" &&
  grep -Fxq vol-2222bbbb "$GG_PV_INVENTORY_FILE" &&
  grep -Fxq vol-3333cccc "$GG_PV_INVENTORY_FILE" &&
  ok "cross-namespace PVC cleanup records claimed and released EBS volumes" || fail "cross-namespace PVC cleanup records claimed and released EBS volumes assertions"

setup stuck
echo 999 >"$STUB_DIR/lb_polls"
if run_pre sandbox 0; then fail "stuck load balancer fails the destroy"; fi
grep -q "load balancers still present" "$STUB_DIR/out" && ok "a load balancer that never goes away stops the destroy" || fail "a load balancer that never goes away stops the destroy assertions"

setup wrong-account
echo 999999999999 >"$STUB_DIR/account"
if run_pre; then fail "wrong account is refused"; fi
grep -q "expected 123456789012" "$STUB_DIR/out" && ! grep -q "delete-stack\|kubectl" "$STUB_DIR/calls" && ok "a different AWS account is refused before any deletion" || fail "a different AWS account is refused before any deletion assertions"

setup inventory-preflight-denied
touch "$STUB_DIR/stack" "$STUB_DIR/edge_inventory_error"
if run_pre; then fail "inventory permission failure must stop before mutations"; fi
! grep -q 'cloudformation delete-stack\|logs delete-log-group' "$STUB_DIR/calls" && ok "inventory permission denial stops before AWS cleanup" || fail "inventory permission denial stops before AWS cleanup assertions"

setup delete-preflight-denied
touch "$STUB_DIR/stack" "$STUB_DIR/delete_denied"
if run_pre; then fail "delete permission failure must stop before mutations"; fi
grep -q 'AWS delete permissions denied' "$STUB_DIR/out" &&
  ! grep -q 'cloudformation delete-stack\|logs delete-log-group' "$STUB_DIR/calls" && ok "delete permission denial stops before AWS cleanup" || fail "delete permission denial stops before AWS cleanup assertions"

setup unreachable-cluster
touch "$STUB_DIR/cluster" "$STUB_DIR/stack" "$STUB_DIR/api_unreachable"
if run_pre; then fail "private EKS API unreachable must stop cleanup"; fi
grep -q "EKS API is unreachable" "$STUB_DIR/out" &&
  ! grep -q "cloudformation delete-stack\|delete ingress" "$STUB_DIR/calls" && ok "unreachable EKS API stops before destructive cleanup" || fail "unreachable EKS API stops before destructive cleanup assertions"

setup clean
"$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1 || fail "clean account passes"
grep -q "no GreenGuard resources found" "$STUB_DIR/out" && ok "post-destroy check passes on a clean account" || fail "post-destroy check passes on a clean account assertions"

setup sentinel-missing-manifest
if "$here/post-destroy-inventory.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 "$GG_PV_INVENTORY_FILE.scope.json" "$GG_PV_INVENTORY_FILE" >"$STUB_DIR/out" 2>&1; then fail "sentinel must fail without its pre-destroy manifest"; fi
grep -q 'saved destroy inventory is missing or invalid' "$STUB_DIR/out" &&
  [ ! -f "$STUB_DIR/calls" ] && ok "sentinel refuses missing manifest before AWS inventory calls" || fail "sentinel refuses missing manifest before AWS inventory calls assertions"

setup sentinel-invalid-manifest
echo '{invalid' >"$GG_PV_INVENTORY_FILE.scope.json"
chmod 600 "$GG_PV_INVENTORY_FILE.scope.json"
if "$here/post-destroy-inventory.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 "$GG_PV_INVENTORY_FILE.scope.json" "$GG_PV_INVENTORY_FILE" >"$STUB_DIR/out" 2>&1; then fail "sentinel must fail on invalid manifest"; fi
grep -q 'saved destroy inventory is missing or invalid' "$STUB_DIR/out" &&
  [ ! -f "$STUB_DIR/calls" ] && ok "sentinel refuses invalid manifest before AWS inventory calls" || fail "sentinel refuses invalid manifest before AWS inventory calls assertions"

setup sentinel-dirty-retry
GG_REGION=us-east-1 GG_ENVIRONMENT=sandbox GG_CLUSTER=greenguard-sandbox-cell-1 GG_ACCOUNT=123456789012 \
  GG_MASTER_SECRET_ARN= GG_SHARD_MASTER_SECRET_ARNS='[]' \
  python3 "$here/destroy-scope-manifest.py" save-env "$GG_PV_INVENTORY_FILE.scope.json"
echo 'arn:aws:ec2:us-east-1:123456789012:natgateway/nat-1' >"$STUB_DIR/tagged"
if "$here/post-destroy-inventory.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 "$GG_PV_INVENTORY_FILE.scope.json" "$GG_PV_INVENTORY_FILE" >"$STUB_DIR/out" 2>&1; then fail "sentinel must fail when inventory finds a resource"; fi
grep -q 'natgateway/nat-1' "$STUB_DIR/out" &&
  [ -f "$GG_PV_INVENTORY_FILE.scope.json" ] && ok "dirty final inventory fails and retains retry manifest" || fail "dirty final inventory fails and retains retry manifest assertions"
rm "$STUB_DIR/tagged"
"$here/post-destroy-inventory.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 "$GG_PV_INVENTORY_FILE.scope.json" "$GG_PV_INVENTORY_FILE" >"$STUB_DIR/out" 2>&1 || fail "sentinel inventory retry should pass after resource deletion"
[ ! -e "$GG_PV_INVENTORY_FILE.scope.json" ] && ok "clean sentinel retry passes and removes its stale scope manifest" || fail "clean sentinel retry passes and removes its stale scope manifest assertions"

setup rds-not-found
touch "$STUB_DIR/rds_missing"
"$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1 || fail "missing disposable RDS instance should pass"
grep -q "no GreenGuard resources found" "$STUB_DIR/out" && ok "exact RDS lookup treats only DBInstanceNotFound as absent" || fail "exact RDS lookup treats only DBInstanceNotFound as absent assertions"

setup rds-inventory-error
touch "$STUB_DIR/rds_error"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "RDS API error must fail inventory"; fi
grep -q 'PostgreSQL instance inventory failed' "$STUB_DIR/out" && ok "exact RDS lookup fails closed on other errors" || fail "exact RDS lookup fails closed on other errors assertions"

if command -v shasum >/dev/null; then
  cell_hash="$(printf '%s' greenguard-sandbox-cell-1 | shasum -a 256 | awk '{print substr($1,1,8)}')"
  ecr_cell_hash="$(printf '%s' greenguard-sandbox-cell-1 | shasum -a 256 | awk '{print substr($1,1,16)}')"
else
  cell_hash="$(printf '%s' greenguard-sandbox-cell-1 | sha256sum | awk '{print substr($1,1,8)}')"
  ecr_cell_hash="$(printf '%s' greenguard-sandbox-cell-1 | sha256sum | awk '{print substr($1,1,16)}')"
fi
postgres_name="gg-greenguard-sandbox-cell-1-${cell_hash}-postgres"
audit_bucket="greenguard-sandbox-cell-1-${cell_hash}-123456789012-us-east-1-audit"
region=us-east-1
cluster_name=greenguard-sandbox-cell-1
archive_prefix_length=$((29 - ${#region}))
telemetry_archive_bucket="${cluster_name:0:archive_prefix_length}-${cell_hash}-123456789012-${region}-telemetry"
notification_state_table="greenguard-sandbox-cell-1-${cell_hash}-notification-state"

setup inventory-data
echo "$postgres_name" >"$STUB_DIR/rds_instances"
echo "${postgres_name}-manual-backup" >"$STUB_DIR/rds_snapshots"
printf '%s\n%s\n' "$audit_bucket" "$telemetry_archive_bucket" >"$STUB_DIR/s3_buckets"
echo "$notification_state_table" >"$STUB_DIR/notification_state_table"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "data resources must fail the inventory"; fi
grep -q "Disposable PostgreSQL instance" "$STUB_DIR/out" &&
  grep -q "Disposable PostgreSQL manual snapshots" "$STUB_DIR/out" &&
  grep -q "Disposable audit export S3 bucket" "$STUB_DIR/out" &&
  grep -q "Disposable telemetry archive S3 bucket" "$STUB_DIR/out" &&
  grep -q "Disposable notification state DynamoDB table" "$STUB_DIR/out" && ok "exact RDS, snapshot, S3, and DynamoDB leftovers are reported" || fail "exact RDS, snapshot, S3, and DynamoDB leftovers are reported assertions"

setup inventory-ecr-and-customer-secrets
printf 'greenguard/sandbox/cell-%s/device-service\ngreenguard/sandbox/cell-%s/read-api\ngreenguard/read-api\n' "$ecr_cell_hash" "$ecr_cell_hash" >"$STUB_DIR/ecr_repositories"
printf 'arn:aws:secretsmanager:us-east-1:123456789012:secret:greenguard/sandbox/read-api-Ab12\narn:aws:secretsmanager:us-east-1:123456789012:secret:greenguard/sandbox/shards/s1/bootstrap-Cd34\narn:aws:secretsmanager:us-east-1:123456789012:secret:greenguard/sandbox/retiring-secret-Ef56\n' >"$STUB_DIR/customer_secret_arns"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "Terraform-owned ECR repositories and customer secret containers must fail inventory"; fi
grep -q 'Terraform-owned ECR repositories for sandbox/greenguard-sandbox-cell-1' "$STUB_DIR/out" &&
  grep -q "greenguard/sandbox/cell-$ecr_cell_hash/device-service" "$STUB_DIR/out" &&
  grep -q 'Disposable customer Secrets Manager containers' "$STUB_DIR/out" &&
  grep -q 'greenguard/sandbox/shards/s1/bootstrap-Cd34' "$STUB_DIR/out" &&
  grep -q 'greenguard/sandbox/retiring-secret-Ef56' "$STUB_DIR/out" &&
  grep -q "ecr describe-repositories.*starts_with(repositoryName, 'greenguard/sandbox/cell-$ecr_cell_hash/')" "$STUB_DIR/calls" &&
  grep -q "secretsmanager list-secrets --include-planned-deletion.*starts_with(Name, 'greenguard/sandbox/')" "$STUB_DIR/calls" &&
  grep -Fq "contains(not_null(" "$STUB_DIR/calls" &&
  grep -Fq "Tags[?Key=='Cell'].Value" "$STUB_DIR/calls" &&
  grep -Fq "'greenguard-sandbox-cell-1')" "$STUB_DIR/calls" &&
  ! grep -q '^greenguard/read-api$' "$STUB_DIR/out" &&
  ok "direct regional inventory scopes ECR and customer secrets to the disposable cell" || fail "direct regional inventory scopes ECR and customer secrets to the disposable cell assertions"

setup inventory-vpc-nat-eip
printf 'vpc-cell\n' >"$STUB_DIR/cell_vpcs"
printf 'igw-cell\n' >"$STUB_DIR/cell_igws"
printf 'nat-cell\n' >"$STUB_DIR/cell_nat_gateways"
printf 'eipalloc-cell\n' >"$STUB_DIR/cell_nat_eips"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "orphaned cell VPC/NAT/EIP resources must fail inventory"; fi
grep -q 'Disposable VPC' "$STUB_DIR/out" && grep -q 'vpc-cell' "$STUB_DIR/out" &&
  grep -q 'Disposable internet gateway' "$STUB_DIR/out" && grep -q 'igw-cell' "$STUB_DIR/out" &&
  grep -q 'Disposable NAT gateways' "$STUB_DIR/out" && grep -q 'nat-cell' "$STUB_DIR/out" &&
  grep -q 'Disposable NAT gateway Elastic IPs' "$STUB_DIR/out" && grep -q 'eipalloc-cell' "$STUB_DIR/out" &&
  grep -q 'ec2 describe-nat-gateways.*tag:Name' "$STUB_DIR/calls" && ok "exact cell Name inventory catches orphaned VPC, IGW, NAT and NAT EIP" || fail "exact cell Name inventory catches orphaned VPC, IGW, NAT and NAT EIP assertions"

setup inventory-ecr-denied
touch "$STUB_DIR/ecr_error"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "ECR inventory API errors must fail closed"; fi
grep -q 'ECR repository inventory failed: AccessDenied' "$STUB_DIR/out" && ok "ECR inventory errors fail closed" || fail "ECR inventory errors fail closed assertions"

setup inventory-customer-secrets-denied
touch "$STUB_DIR/customer_secrets_error"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "customer Secrets Manager inventory API errors must fail closed"; fi
grep -q 'customer Secrets Manager inventory failed: AccessDenied' "$STUB_DIR/out" && ok "customer Secrets Manager inventory errors fail closed" || fail "customer Secrets Manager inventory errors fail closed assertions"

setup notification-table-inventory-error
touch "$STUB_DIR/dynamodb_error"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "DynamoDB inventory API errors must fail closed"; fi
grep -q 'notification state DynamoDB inventory failed' "$STUB_DIR/out" && ok "DynamoDB inventory errors fail closed" || fail "DynamoDB inventory errors fail closed assertions"

setup inventory-pv-volume
echo vol-1234abcd >"$STUB_DIR/pv-ids"
echo vol-1234abcd >"$STUB_DIR/volumes"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "saved PV volume must fail the inventory"; fi
grep -q 'GreenGuard EBS volume from saved PV' "$STUB_DIR/out" && ok "only an exact saved PV volume is reported" || fail "only an exact saved PV volume is reported assertions"

setup inventory-pv-missing
rm "$STUB_DIR/pv-ids"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "missing PV inventory must fail closed"; fi
grep -q 'PV inventory unavailable' "$STUB_DIR/out" && ok "missing PV inventory fails closed" || fail "missing PV inventory fails closed assertions"

setup inventory-master-secret
master_secret_arn='arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-test'
echo "$master_secret_arn" >"$STUB_DIR/master_secret"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 "$master_secret_arn" >"$STUB_DIR/out" 2>&1; then fail "RDS-managed secret must fail the inventory"; fi
grep -q 'RDS-managed master secret still exists' "$STUB_DIR/out" && ok "RDS-managed master secret leftover is reported" || fail "RDS-managed master secret leftover is reported assertions"

setup inventory-edge-global
echo 'arn:aws:cloudfront::123456789012:distribution/WEB' >"$STUB_DIR/web_distribution"
echo 'arn:aws:cloudfront::123456789012:distribution/API' >"$STUB_DIR/api_distribution"
echo 'arn:aws:cloudfront::123456789012:vpcorigin/EDGE' >"$STUB_DIR/vpc_origin"
echo 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/EDGE' >"$STUB_DIR/edge_waf"
echo 'us-east-1_POOL' >"$STUB_DIR/cognito_pool"
echo 'us-east-1_POOL' >"$STUB_DIR/cognito_domain"
echo 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/EDGE' >"$STUB_DIR/edge_alb"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "edge and identity resources must fail the inventory"; fi
grep -q 'Disposable CloudFront distributions' "$STUB_DIR/out" &&
  grep -q 'Disposable CloudFront VPC origin' "$STUB_DIR/out" &&
  grep -q 'Disposable CloudFront WAF ACL' "$STUB_DIR/out" &&
  grep -q 'Disposable Cognito user pool' "$STUB_DIR/out" &&
  grep -q 'Disposable Cognito hosted domain' "$STUB_DIR/out" &&
  grep -q 'Disposable private edge ALB' "$STUB_DIR/out" && ok "exact global edge and identity leftovers are reported" || fail "exact global edge and identity leftovers are reported assertions"

setup inventory-edge-denied
touch "$STUB_DIR/edge_inventory_error"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "CloudFront inventory denial must fail"; fi
grep -q 'AccessDenied' "$STUB_DIR/out" && ok "CloudFront inventory errors fail closed" || fail "CloudFront inventory errors fail closed assertions"

setup inventory-cognito-domain-missing
touch "$STUB_DIR/cognito_domain_missing"
"$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1 || fail "missing Cognito hosted domain is clean"
grep -q 'no GreenGuard resources found' "$STUB_DIR/out" && ok "missing Cognito hosted domain is a clean inventory" || fail "missing Cognito hosted domain is a clean inventory assertions"

setup inventory-master-secret-missing
"$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 "$master_secret_arn" >"$STUB_DIR/out" 2>&1 || fail "deleted RDS-managed secret should pass"
grep -q 'no GreenGuard resources found' "$STUB_DIR/out" && ok "deleted RDS-managed master secret passes" || fail "deleted RDS-managed master secret passes assertions"

setup neighbor
echo /aws/lambda/greenguard-escalation-mirror-sandbox-old >"$STUB_DIR/logs"
"$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1 || fail "neighbor log group is ignored"
grep -q "no GreenGuard resources found" "$STUB_DIR/out" && ok "post-destroy check ignores a neighboring environment log group" || fail "post-destroy check ignores a neighboring environment log group assertions"

setup dirty
printf 'arn:aws:ec2:us-east-1:1:natgateway/nat-1\tarn:aws:kms:us-east-1:1:key/k\tarn:aws:iam::123456789012:role/greenguard-sandbox-role\tarn:aws:ec2:us-east-1:123456789012:vpc/vpc-1234\n' >"$STUB_DIR/tagged"
touch "$STUB_DIR/cluster"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "dirty account fails"; fi
grep -q "natgateway/nat-1" "$STUB_DIR/out" && grep -q "EKS cluster" "$STUB_DIR/out" &&
  grep -q 'role/greenguard-sandbox-role' "$STUB_DIR/out" && grep -q 'vpc/vpc-1234' "$STUB_DIR/out" &&
  ! grep -q "KMS key not scheduled" "$STUB_DIR/out" && ok "tag inventory reports NAT, IAM and VPC leftovers while ignoring pending-deletion KMS" || fail "tag inventory reports NAT, IAM and VPC leftovers while ignoring pending-deletion KMS assertions"

setup inventory-wrong-account
echo 999999999999 >"$STUB_DIR/account"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "inventory in a different account fails"; fi
grep -q "expected 123456789012" "$STUB_DIR/out" &&
  ! grep -q "resourcegroupstaggingapi" "$STUB_DIR/calls" && ok "inventory refuses a different account before listing resources" || fail "inventory refuses a different account before listing resources assertions"

setup inventory-flow-log
echo /aws/vpc/greenguard-sandbox-cell-1/flow >"$STUB_DIR/logs"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "VPC flow log remains"; fi
grep -q "/aws/vpc/greenguard-sandbox-cell-1/flow" "$STUB_DIR/out" && ok "inventory reports an exact VPC flow log" || fail "inventory reports an exact VPC flow log assertions"

setup inventory-tagging-denied
touch "$STUB_DIR/tagging_error"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "tagging API failure must fail the inventory"; fi
grep -q "AccessDenied" "$STUB_DIR/out" && ok "tagging API failure cannot pass as an empty inventory" || fail "tagging API failure cannot pass as an empty inventory assertions"

setup inventory-kms-denied
echo 'arn:aws:kms:us-east-1:123456789012:key/test' >"$STUB_DIR/tagged"
touch "$STUB_DIR/kms_error" "$STUB_DIR/stack"
if run_pre; then fail "KMS inventory denial must stop before cleanup"; fi
grep -q 'KMS key inventory failed' "$STUB_DIR/out" &&
  ! grep -q 'cloudformation delete-stack\|logs delete-log-group' "$STUB_DIR/calls" &&
  ok "KMS inventory denial stops before AWS cleanup" || fail "KMS inventory denial stops before AWS cleanup assertions"

setup wrapper-clean
GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1 || fail "verified destroy wrapper succeeds on empty inventory"
grep -q '^terraform destroy$' "$STUB_DIR/calls" &&
  [ ! -e "$GG_PV_INVENTORY_FILE.scope.json" ] &&
  [ "$(grep -c '^aws sts get-caller-identity' "$STUB_DIR/calls")" -eq 4 ] &&
  [ "$(grep -n '^aws sts get-caller-identity' "$STUB_DIR/calls" | head -n 1 | cut -d: -f1)" -lt "$(grep -n '^terraform destroy$' "$STUB_DIR/calls" | cut -d: -f1)" ] &&
  ok "verified wrapper pre-cleans, destroys, then inventories" || fail "verified wrapper pre-cleans, destroys, then inventories assertions"

setup wrapper-partial-apply
touch "$STUB_DIR/identity_error" "$STUB_DIR/cluster"
printf '%s\n' '{"values":{"root_module":{"resources":[{"address":"aws_eks_cluster.cell","mode":"managed","values":{"arn":"arn:aws:eks:us-east-1:123456789012:cluster/greenguard-sandbox-cell-1","name":"greenguard-sandbox-cell-1","tags_all":{"Project":"GreenGuard","Environment":"sandbox"}}}]}}}' >"$STUB_DIR/show_state"
GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1 || fail "partial apply with EKS state identity should clean up"
grep -q '^terraform show -json$' "$STUB_DIR/calls" &&
  grep -q 'kubectl .*delete pvc --all' "$STUB_DIR/calls" &&
  grep -q '^terraform destroy$' "$STUB_DIR/calls" &&
  ok "partial apply recovers EKS scope and pre-cleans before destroy" || fail "partial apply recovers EKS scope and pre-cleans before destroy assertions"

setup wrapper-partial-before-eks
touch "$STUB_DIR/identity_error"
rm "$GG_PV_INVENTORY_FILE"
printf '%s\n' '{"values":{"root_module":{"resources":[{"address":"terraform_data.cell_scope","mode":"managed","values":{"input":{"region":"us-east-1","environment":"sandbox","cluster_name":"greenguard-sandbox-cell-1","account_id":"123456789012"}}},{"address":"aws_vpc.cell","mode":"managed","values":{"tags":{"Name":"greenguard-sandbox-cell-1-vpc"},"tags_all":{"Project":"GreenGuard","Environment":"sandbox"}}}]}}}' >"$STUB_DIR/show_state"
GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1 || fail "partial apply before EKS should recover saved scope"
grep -q '^terraform destroy$' "$STUB_DIR/calls" && [ -f "$GG_PV_INVENTORY_FILE" ] &&
  ! grep -q 'kubectl ' "$STUB_DIR/calls" && ok "pre-EKS partial apply uses saved cell scope" || fail "pre-EKS partial apply uses saved cell scope assertions"

setup wrapper-pre-cleanup-fails
touch "$STUB_DIR/cluster" "$STUB_DIR/api_unreachable"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "unreachable Kubernetes API must block Terraform destroy"; fi
grep -q 'EKS API is unreachable' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "pre-cleanup failure preserves Terraform state/resources" || fail "pre-cleanup failure preserves Terraform state/resources assertions"

setup wrapper-partial-rds-secret-missing
touch "$STUB_DIR/identity_error"
printf '%s\n' '{"values":{"root_module":{"resources":[{"address":"aws_eks_cluster.cell","mode":"managed","values":{"arn":"arn:aws:eks:us-east-1:123456789012:cluster/greenguard-sandbox-cell-1","name":"greenguard-sandbox-cell-1","tags_all":{"Project":"GreenGuard","Environment":"sandbox"}}},{"address":"aws_db_instance.postgres","mode":"managed","values":{"master_user_secret":[]}}]}}}' >"$STUB_DIR/show_state"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "partial RDS state without master secret ARN must stop destroy"; fi
grep -q 'RDS master secret ARN is unavailable' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "partial state preserves RDS secret inventory requirement" || fail "partial state preserves RDS secret inventory requirement assertions"

setup wrapper-invalid-output-identity
printf '%s\n' '{"region":"invalid","environment":"sandbox","cluster_name":"greenguard-sandbox-cell-1","account_id":"123456789012"}' >"$STUB_DIR/identity"
printf '%s\n' '{"values":{"root_module":{"resources":[{"address":"aws_eks_cluster.cell","mode":"managed","values":{"arn":"arn:aws:eks:us-east-1:123456789012:cluster/greenguard-sandbox-cell-1","name":"greenguard-sandbox-cell-1","tags_all":{"Project":"GreenGuard","Environment":"sandbox"}}}]}}}' >"$STUB_DIR/show_state"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "invalid output identity must not fall back to partial state"; fi
grep -q 'invalid Terraform state identity' "$STUB_DIR/out" &&
  ! grep -q '^terraform show -json$' "$STUB_DIR/calls" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "invalid saved identity refuses partial-state fallback" || fail "invalid saved identity refuses partial-state fallback assertions"

setup wrapper-terraform-fails
touch "$STUB_DIR/terraform_error"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "Terraform failure must stop wrapper"; fi
[ "$(grep -c '^aws sts get-caller-identity' "$STUB_DIR/calls")" -eq 3 ] && ok "verified wrapper does not run inventory after failed destroy" || fail "verified wrapper does not run inventory after failed destroy assertions"

setup wrapper-inventory-fails
echo 'arn:aws:ec2:us-east-1:1:natgateway/nat-1' >"$STUB_DIR/tagged"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "remaining resource must fail wrapper"; fi
grep -q 'natgateway/nat-1' "$STUB_DIR/out" &&
  [ -f "$GG_PV_INVENTORY_FILE.scope.json" ] &&
  [ "$(python3 -c 'import os,stat,sys; print(format(stat.S_IMODE(os.stat(sys.argv[1]).st_mode), "o"))' "$GG_PV_INVENTORY_FILE.scope.json")" = 600 ] &&
  ok "verified wrapper retains a private retry manifest when inventory finds a resource" || fail "verified wrapper retains a private retry manifest when inventory finds a resource assertions"
touch "$STUB_DIR/identity_error"
printf '%s\n' '{"values":{"root_module":{"resources":[]}}}' >"$STUB_DIR/show_state"
rm -f "$STUB_DIR/tagged"
GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1 || fail "saved-scope retry succeeds after Terraform state is empty"
[ ! -e "$GG_PV_INVENTORY_FILE.scope.json" ] &&
  grep -q 'terraform destroy' "$STUB_DIR/calls" &&
  ok "empty-state retry uses the saved exact scope and removes the manifest only after clean inventory" || fail "empty-state retry uses the saved exact scope and removes the manifest only after clean inventory assertions"

setup wrapper-master-secret
echo "$master_secret_arn" >"$STUB_DIR/master_secret_output"
echo "$master_secret_arn" >"$STUB_DIR/master_secret"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "remaining RDS-managed secret must fail wrapper"; fi
grep -q 'RDS-managed master secret still exists' "$STUB_DIR/out" &&
  grep -q 'secretsmanager describe-secret' "$STUB_DIR/calls" && ok "verified wrapper retains and checks RDS master secret ARN" || fail "verified wrapper retains and checks RDS master secret ARN assertions"

setup wrapper-master-secret-wrong-account
echo 'arn:aws:secretsmanager:us-east-1:999999999999:secret:rds!db-test' >"$STUB_DIR/master_secret_output"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "foreign RDS master secret ARN must stop destroy"; fi
grep -q 'does not match saved region/account' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "verified wrapper refuses mismatched RDS secret ARN" || fail "verified wrapper refuses mismatched RDS secret ARN assertions"

setup wrapper-master-secret-empty
: >"$STUB_DIR/master_secret_output"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "empty RDS master secret output must stop destroy"; fi
grep -q 'invalid RDS master secret output' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "verified wrapper refuses an empty present RDS secret output" || fail "verified wrapper refuses an empty present RDS secret output assertions"

setup wrapper-mismatched-scope
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" us-west-2 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "mismatched inventory region must fail"; fi
grep -q 'do not match' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "verified wrapper rejects region mismatches before destroy" || fail "verified wrapper rejects region mismatches before destroy assertions"

setup wrapper-missing-identity
touch "$STUB_DIR/identity_error"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "missing identity must fail"; fi
grep -q 'cannot recover a unique cell identity from partial state' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "verified wrapper refuses missing state identity" || fail "verified wrapper refuses missing state identity assertions"

setup wrapper-output-error
touch "$STUB_DIR/output_error"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "Terraform output error must stop destroy"; fi
grep -q 'invalid Terraform state identity' "$STUB_DIR/out" &&
  ! grep -q '^terraform show -json$' "$STUB_DIR/calls" &&
  ! grep -q '^aws ' "$STUB_DIR/calls" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "verified wrapper fails closed on state output read error" || fail "verified wrapper fails closed on state output read error assertions"

[ "$pass" -eq 71 ] || fail "expected 71 pre-shard teardown assertions"

setup shard_leftovers
echo 'gg-greenguard-sandbox-cell-1-deadbeef-shard-s3-r1' >"$STUB_DIR/shard_instances"
echo 'manual-s4-snapshot' >"$STUB_DIR/shard_snapshots"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "shard leftovers must fail"; fi
grep -q 'Disposable shard primaries and read replicas' "$STUB_DIR/out" &&
  grep -q 'Disposable shard manual snapshots' "$STUB_DIR/out" && ok "shard primary/replica and manual snapshot leftovers are reported without tags" || fail "shard primary/replica and manual snapshot leftovers are reported without tags assertions"

setup shard_secret_leftover
echo 'arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!s2' >"$STUB_DIR/master_secret"
if GG_SHARD_MASTER_SECRET_ARNS="$(cat "$STUB_DIR/master_secret")" "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "shard secret leftover must fail"; fi
grep -q 'RDS-managed shard master secret still exists' "$STUB_DIR/out" && ok "captured shard master secret leftovers are reported" || fail "captured shard master secret leftovers are reported assertions"

setup foreign_shard_secret
if GG_SHARD_MASTER_SECRET_ARNS='arn:aws:secretsmanager:us-east-1:999999999999:secret:rds!s2' "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "foreign shard secret must fail"; fi
grep -q 'shard master secret ARN does not match region/account' "$STUB_DIR/out" && ok "foreign shard secret ARN refuses inventory" || fail "foreign shard secret ARN refuses inventory assertions"

setup shard_wrapper
python3 -c 'import json; print(json.dumps({f"s{i}": {"master_secret_arn":f"arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!s{i}"} for i in range(1,5)}))' >"$STUB_DIR/shard_output"
echo 'arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!s3' >"$STUB_DIR/master_secret"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "remaining captured shard master secrets must fail wrapper"; fi
grep -q 'RDS-managed shard master secret still exists' "$STUB_DIR/out" &&
  grep -q 'secret:rds!s4' "$STUB_DIR/calls" &&
  grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "verified wrapper retains and checks all four managed shard master secrets" || fail "verified wrapper retains and checks all four managed shard master secrets assertions"

setup shard_secret_deduplicated
python3 -c 'import json; print(json.dumps({f"s{i}": {"master_secret_arn":f"arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!s{i}"} for i in range(1,5)}))' >"$STUB_DIR/shard_output"
python3 - "$STUB_DIR/show_state" <<'PY'
import json, sys
resources = []
for shard in range(1, 5):
    resources.append({
        "address": f'aws_db_instance.shard["s{shard}"]',
        "type": "aws_db_instance",
        "name": "shard",
        "mode": "managed",
        "values": {"master_user_secret": [{"secret_arn": f"arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!s{shard}"}]},
    })
with open(sys.argv[1], "w") as output:
    json.dump({"values": {"root_module": {"resources": resources}}}, output)
PY
if ! GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "duplicate shard secret inventory must be deduplicated"; fi
grep -q '^terraform destroy$' "$STUB_DIR/calls" &&
  [ "$(grep -c 'secretsmanager describe-secret' "$STUB_DIR/calls")" -eq 4 ] &&
  grep -q 'secret:rds!s4' "$STUB_DIR/calls" && ok "verified wrapper deduplicates full current-state ARNs and checks all four shard secrets" || fail "verified wrapper deduplicates full current-state ARNs and checks all four shard secrets assertions"

setup foreign_shard_wrapper
python3 -c 'import json; print(json.dumps({f"s{i}": {"master_secret_arn":f"arn:aws:secretsmanager:us-east-1:999999999999:secret:rds!s{i}"} for i in range(1,5)}))' >"$STUB_DIR/shard_output"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "foreign shard registry must stop destroy"; fi
grep -q 'shard master secret ARN does not match saved account/region' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "verified wrapper rejects foreign shard secret registry before deletion" || fail "verified wrapper rejects foreign shard secret registry before deletion assertions"

setup stale_populated_shard_update
python3 -c 'import json; print(json.dumps({f"s{i}": {"master_secret_arn":f"arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!old-s{i}"} for i in range(1,5)}))' >"$STUB_DIR/shard_output"
printf '%s\n' '{"values":{"root_module":{"resources":[{"address":"aws_db_instance.shard[\"s2\"]","type":"aws_db_instance","name":"shard","mode":"managed","values":{"master_user_secret":[{"secret_arn":"arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!new-s2"}]}}]}}}' >"$STUB_DIR/show_state"
echo 'arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!new-s2' >"$STUB_DIR/master_secret"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "populated stale outputs must not hide current managed shard secrets"; fi
grep -q 'RDS-managed shard master secret still exists' "$STUB_DIR/out" &&
  grep -q 'secret:rds!new-s2' "$STUB_DIR/calls" &&
  grep -q 'secret:rds!old-s4' "$STUB_DIR/calls" && ok "managed secret inventory unions populated stale outputs with current state" || fail "managed secret inventory unions populated stale outputs with current state assertions"

setup partial_shard_update
printf '%s\n' '{"values":{"root_module":{"resources":[{"address":"aws_db_instance.shard[\"s2\"]","type":"aws_db_instance","name":"shard","mode":"managed","values":{"master_user_secret":[{"secret_arn":"arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!partial-s2"}]}}]}}}' >"$STUB_DIR/show_state"
echo 'arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!partial-s2' >"$STUB_DIR/master_secret"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "failed update shards hidden by old outputs must still fail secret inventory"; fi
grep -q 'RDS-managed shard master secret still exists' "$STUB_DIR/out" &&
  grep -q 'secret:rds!partial-s2' "$STUB_DIR/calls" && ok "failed update shards are inventoried from state despite stale root outputs" || fail "failed update shards are inventoried from state despite stale root outputs assertions"

setup all_four_shard_secrets_replaced
python3 - "$STUB_DIR/shard_output" "$STUB_DIR/show_state" <<'PY'
import json, sys
registry = {f"s{i}": {"master_secret_arn": f"arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!old-s{i}"} for i in range(1, 5)}
resources = [{"address": f'aws_db_instance.shard["s{i}"]', "index": f"s{i}", "mode": "managed", "type": "aws_db_instance", "name": "shard", "values": {"master_user_secret": [{"secret_arn": f"arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!new-s{i}"}]}} for i in range(1, 5)]
with open(sys.argv[1], "w") as output: json.dump(registry, output)
with open(sys.argv[2], "w") as output: json.dump({"values": {"root_module": {"resources": resources}}}, output)
PY
echo 'arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!new-s4' >"$STUB_DIR/master_secret"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "a current generation secret must fail final inventory"; fi
[ "$(grep -c 'secretsmanager describe-secret' "$STUB_DIR/calls")" -eq 8 ] &&
  grep -q 'rds!old-s1' "$STUB_DIR/calls" && grep -q 'rds!new-s4' "$STUB_DIR/calls" &&
  ! grep -q 'secretsmanager delete-' "$STUB_DIR/calls" &&
  python3 - "$GG_PV_INVENTORY_FILE.scope.json" <<'PY' || fail "all replaced shard secrets must be retained for read-only inventory"
import json, stat, sys
from pathlib import Path
path = Path(sys.argv[1]); document = json.loads(path.read_text())
assert len(document["shard_master_secret_arns"]) == 8
assert stat.S_IMODE(path.stat().st_mode) == 0o600
PY
ok "all four replaced shards retain both generations without secret deletion"
# After state disappears, the durable inventory must still query both generations.
touch "$STUB_DIR/identity_error"
printf '%s\n' '{"values":{"root_module":{"resources":[]}}}' >"$STUB_DIR/show_state"
rm -f "$STUB_DIR/master_secret"
: >"$STUB_DIR/calls"
GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1 || fail "historical secret retry must pass after both generations are gone"
[ "$(grep -c 'secretsmanager describe-secret' "$STUB_DIR/calls")" -eq 8 ] &&
  [ ! -e "$GG_PV_INVENTORY_FILE.scope.json" ] &&
  ! grep -q 'secretsmanager delete-' "$STUB_DIR/calls" &&
  ok "empty-state retry reads durable history and removes it only after clean inventory" || fail "durable rotated-shard retry assertions"

for invalid_capture in invalid-index duplicate-index wrong-region wrong-account duplicate-secret; do
  setup "capture-$invalid_capture"
  python3 - "$invalid_capture" "$STUB_DIR/show_state" <<'PY'
import json, sys
kind = sys.argv[1]
resource = {"address": 'aws_db_instance.shard["s1"]', "index": "s1", "mode": "managed", "type": "aws_db_instance", "name": "shard", "values": {"master_user_secret": [{"secret_arn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!s1"}]}}
resources = [resource]
if kind == "invalid-index": resource["index"] = "s5"
if kind == "duplicate-index": resources.append(resource.copy())
if kind == "wrong-region": resource["values"]["master_user_secret"][0]["secret_arn"] = "arn:aws:secretsmanager:us-west-2:123456789012:secret:rds!s1"
if kind == "wrong-account": resource["values"]["master_user_secret"][0]["secret_arn"] = "arn:aws:secretsmanager:us-east-1:999999999999:secret:rds!s1"
if kind == "duplicate-secret":
    duplicate = resource.copy(); duplicate["address"] = 'aws_db_instance.shard["s2"]'; duplicate["index"] = "s2"; resources.append(duplicate)
with open(sys.argv[2], "w") as output: json.dump({"values": {"root_module": {"resources": resources}}}, output)
PY
  if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "$invalid_capture capture must fail"; fi
  ! grep -q '^aws ' "$STUB_DIR/calls" && ! grep -q '^terraform destroy' "$STUB_DIR/calls" &&
    [ ! -e "$GG_PV_INVENTORY_FILE.scope.json" ] &&
    ok "$invalid_capture source capture fails before AWS calls or destroy" || fail "$invalid_capture failed capture assertions"
done
[ "$pass" -eq 86 ] || fail "expected 86 complete teardown assertions"

setup current_tag_template_cleanup_without_cluster
template_fixture mixed
run_pre || fail "current-tag Karpenter template must be deleted without a live cluster"
grep -q 'aws ec2 delete-launch-template --launch-template-id lt-0abc1234' "$STUB_DIR/calls" &&
  [ "$(grep -c 'aws ec2 delete-launch-template' "$STUB_DIR/calls")" -eq 1 ] &&
  python3 - "$STUB_DIR/karpenter_launch_templates.json" <<'PY' || fail "launch template cleanup must preserve every neighboring or unrelated resource"
import json, sys
records = json.load(open(sys.argv[1]))["LaunchTemplates"]
assert {record["LaunchTemplateId"] for record in records} == {"lt-0bbb2222", "lt-0ccc3333", "lt-0ddd4444", "lt-0eee5555", "lt-0fff6666"}
PY
ok "current-tag owned Karpenter template is deleted while all negative ownership cases remain"

setup current_tag_template_inventory_scoping
template_fixture mixed
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "owned current-tag template must fail final inventory"; fi
grep -q 'lt-0abc1234' "$STUB_DIR/out" && ! grep -q 'lt-0bbb2222\|lt-0ccc3333\|lt-0ddd4444\|lt-0eee5555\|lt-0fff6666' "$STUB_DIR/out" || fail "final inventory must identify only the owned current-tag template"
template_fixture negatives
"$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1 || fail "negative ownership cases must not be attributed to this Karpenter cell"
! grep -q 'aws ec2 delete-launch-template' "$STUB_DIR/calls" &&
  ok "final template inventory detects current ownership and excludes neighbor unrelated shared and legacy tags" || fail "current launch template inventory ownership assertions"

setup current_tag_template_inventory_denied
touch "$STUB_DIR/karpenter_template_error" "$STUB_DIR/stack"
if run_pre; then fail "launch template inventory denial must stop cleanup"; fi
! grep -q 'cloudformation delete-stack\|aws ec2 delete-launch-template\|aws ec2 terminate-instances' "$STUB_DIR/calls" &&
  ok "launch template inventory errors stop before AWS mutations" || fail "launch template denied inventory assertions"
[ "$pass" -eq 89 ] || fail "expected 89 complete teardown assertions"
echo "all teardown checks including pinned current-tag ownership: $pass passed"
