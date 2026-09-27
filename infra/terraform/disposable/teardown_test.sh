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
  "sts get-caller-identity") cat "$STUB_DIR/account" 2>/dev/null || echo 123456789012 ;;
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
  "rds describe-db-instances")
    if [ -f "$STUB_DIR/rds_error" ]; then
      echo 'An error occurred (AccessDenied)' >&2; exit 254
    fi
    if [ -f "$STUB_DIR/rds_missing" ]; then
      echo 'An error occurred (DBInstanceNotFound)' >&2; exit 254
    fi
    cat "$STUB_DIR/rds_instances" 2>/dev/null || true ;;
  "rds describe-db-snapshots") cat "$STUB_DIR/rds_snapshots" 2>/dev/null || true ;;
  "s3api list-buckets") cat "$STUB_DIR/s3_buckets" 2>/dev/null || true ;;
  "elbv2 describe-load-balancers") cat "$STUB_DIR/edge_alb" 2>/dev/null || true ;;
  "cloudfront list-distributions")
    if [ -f "$STUB_DIR/edge_inventory_error" ]; then echo 'AccessDenied: CloudFront inventory unavailable' >&2; exit 254; fi
    if [[ "$*" == *"dashboard"* ]]; then cat "$STUB_DIR/web_distribution" 2>/dev/null || true
    else cat "$STUB_DIR/api_distribution" 2>/dev/null || true; fi ;;
  "cloudfront list-vpc-origins") cat "$STUB_DIR/vpc_origin" 2>/dev/null || true ;;
  "wafv2 list-web-acls") cat "$STUB_DIR/edge_waf" 2>/dev/null || true ;;
  "cognito-idp list-user-pools")
    if [[ "$*" != *"--page-size 60"* || "$*" == *"--max-results"* ]]; then
      echo 'Cognito inventory must use CLI auto-pagination' >&2; exit 254
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
  "kms describe-key") echo PendingDeletion ;;
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
  if [ -f "$STUB_DIR/master_secret_output" ]; then
    secret="$(cat "$STUB_DIR/master_secret_output")"
    printf '{"disposable_cell_identity":{"value":%s},"postgres_master_secret_arn":{"value":"%s"}}\n' "$identity" "$secret"
  else
    printf '{"disposable_cell_identity":{"value":%s}}\n' "$identity"
  fi
  exit 0
}
[ "$1" = show ] && { cat "$STUB_DIR/show_state" 2>/dev/null || printf '%s\n' '{}'; exit 0; }
[ "$1" = destroy ] && [ ! -f "$STUB_DIR/terraform_error" ] && { rm -f "$STUB_DIR/cluster"; exit 0; }
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
ok() { pass=$((pass + 1)); echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; cat "$STUB_DIR/calls" >&2 2>/dev/null || true; exit 1; }
run_pre() {
  GG_PV_INVENTORY_FILE="$STUB_DIR/pv-ids" GG_CLUSTER=greenguard-sandbox-cell-1 GG_REGION=us-east-1 GG_ENVIRONMENT="${1:-sandbox}" GG_ACCOUNT=123456789012 \
    GG_WAIT_SECONDS="${2:-900}" "$here/pre-destroy.sh" >"$STUB_DIR/out" 2>&1
}

setup prod
if run_pre prod; then fail "prod is refused"; fi
grep -q "refusing" "$STUB_DIR/out" && [ ! -f "$STUB_DIR/calls" ] && ok "prod is refused before any AWS call"

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
ok "deletes CDK stack, Kubernetes LB owners and PVCs, then waits for load balancers"

setup argo-crd-forbidden
touch "$STUB_DIR/cluster" "$STUB_DIR/stack" "$STUB_DIR/argo_crd_error"
if run_pre; then fail "Argo CRD API/RBAC failure must stop destroy"; fi
grep -q 'cannot determine whether Argo Applications exist' "$STUB_DIR/out" &&
  ! grep -q 'cloudformation delete-stack\|delete pvc' "$STUB_DIR/calls" && ok "Argo CRD errors fail before destructive cleanup"

setup argo-unlabeled-app
touch "$STUB_DIR/cluster" "$STUB_DIR/stack"
printf '%s\n' '{"items":[{"metadata":{"name":"unlabeled"},"spec":{"destination":{"namespace":"greenguard"}}}]}' >"$STUB_DIR/argo_apps"
if run_pre; then fail "unowned Argo Application targeting greenguard must stop destroy"; fi
grep -q 'Argo Application unlabeled still targets greenguard' "$STUB_DIR/out" &&
  ! grep -q 'cloudformation delete-stack\|delete pvc' "$STUB_DIR/calls" && ok "unlabeled GreenGuard Argo Application blocks before CDK cleanup"

setup argo-crd-absent
touch "$STUB_DIR/cluster" "$STUB_DIR/argo_crd_absent"
run_pre || fail "absent Argo CRD should allow remaining cleanup"
! grep -q 'delete applications.argoproj.io' "$STUB_DIR/calls" && ok "absent Argo CRD skips Argo cleanup"

setup nothing
run_pre || fail "no stack and no cluster is a clean no-op"
! grep -q "delete-stack\|kubectl" "$STUB_DIR/calls" && ok "skips stack and Kubernetes cleanup when absent"

setup preserved-pv-inventory
echo vol-1234abcd >"$GG_PV_INVENTORY_FILE"
run_pre || fail "missing cluster with saved PV inventory should preserve the IDs"
grep -Fxq vol-1234abcd "$GG_PV_INVENTORY_FILE" && ok "retry after EKS deletion retains exact EBS PV IDs"

setup preserved-pv-after-pvc-deletion
touch "$STUB_DIR/cluster"
echo vol-1234abcd >"$GG_PV_INVENTORY_FILE"
run_pre || fail "retry with deleted PVCs should preserve captured EBS IDs"
grep -Fxq vol-1234abcd "$GG_PV_INVENTORY_FILE" && ok "retry with remaining EKS merges saved PV IDs"

setup all-namespace-pv-inventory
touch "$STUB_DIR/cluster"
printf '%s\n' '{"items":[{"spec":{"csi":{"driver":"ebs.csi.aws.com","volumeHandle":"vol-1111aaaa"},"claimRef":{"namespace":"greenguard"}}},{"spec":{"csi":{"driver":"ebs.csi.aws.com","volumeHandle":"vol-2222bbbb"},"claimRef":{"namespace":"monitoring"}}},{"spec":{"csi":{"driver":"ebs.csi.aws.com","volumeHandle":"vol-3333cccc"}}}]}' >"$STUB_DIR/pvs"
run_pre || fail "all claimed EBS PVs should be captured before deleting all namespaces' PVCs"
grep -Fxq vol-1111aaaa "$GG_PV_INVENTORY_FILE" &&
  grep -Fxq vol-2222bbbb "$GG_PV_INVENTORY_FILE" &&
  grep -Fxq vol-3333cccc "$GG_PV_INVENTORY_FILE" &&
  ok "cross-namespace PVC cleanup records claimed and released EBS volumes"

setup stuck
echo 999 >"$STUB_DIR/lb_polls"
if run_pre sandbox 0; then fail "stuck load balancer fails the destroy"; fi
grep -q "load balancers still present" "$STUB_DIR/out" && ok "a load balancer that never goes away stops the destroy"

setup wrong-account
echo 999999999999 >"$STUB_DIR/account"
if run_pre; then fail "wrong account is refused"; fi
grep -q "expected 123456789012" "$STUB_DIR/out" && ! grep -q "delete-stack\|kubectl" "$STUB_DIR/calls" && ok "a different AWS account is refused before any deletion"

setup unreachable-cluster
touch "$STUB_DIR/cluster" "$STUB_DIR/stack" "$STUB_DIR/api_unreachable"
if run_pre; then fail "private EKS API unreachable must stop cleanup"; fi
grep -q "EKS API is unreachable" "$STUB_DIR/out" &&
  ! grep -q "cloudformation delete-stack\|delete ingress" "$STUB_DIR/calls" && ok "unreachable EKS API stops before destructive cleanup"

setup clean
"$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1 || fail "clean account passes"
grep -q "no GreenGuard resources found" "$STUB_DIR/out" && ok "post-destroy check passes on a clean account"

setup rds-not-found
touch "$STUB_DIR/rds_missing"
"$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1 || fail "missing disposable RDS instance should pass"
grep -q "no GreenGuard resources found" "$STUB_DIR/out" && ok "exact RDS lookup treats only DBInstanceNotFound as absent"

setup rds-inventory-error
touch "$STUB_DIR/rds_error"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "RDS API error must fail inventory"; fi
grep -q 'PostgreSQL instance inventory failed' "$STUB_DIR/out" && ok "exact RDS lookup fails closed on other errors"

if command -v shasum >/dev/null; then
  cell_hash="$(printf '%s' greenguard-sandbox-cell-1 | shasum -a 256 | awk '{print substr($1,1,8)}')"
else
  cell_hash="$(printf '%s' greenguard-sandbox-cell-1 | sha256sum | awk '{print substr($1,1,8)}')"
fi
postgres_name="gg-greenguard-sandbox-cell-1-${cell_hash}-postgres"
audit_bucket="greenguard-sandbox-cell-1-${cell_hash}-123456789012-us-east-1-audit"

setup inventory-data
echo "$postgres_name" >"$STUB_DIR/rds_instances"
echo "${postgres_name}-manual-backup" >"$STUB_DIR/rds_snapshots"
echo "$audit_bucket" >"$STUB_DIR/s3_buckets"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "data resources must fail the inventory"; fi
grep -q "Disposable PostgreSQL instance" "$STUB_DIR/out" &&
  grep -q "Disposable PostgreSQL manual snapshots" "$STUB_DIR/out" &&
  grep -q "Disposable audit export S3 bucket" "$STUB_DIR/out" && ok "exact RDS, snapshot, and S3 leftovers are reported"

setup inventory-pv-volume
echo vol-1234abcd >"$STUB_DIR/pv-ids"
echo vol-1234abcd >"$STUB_DIR/volumes"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "saved PV volume must fail the inventory"; fi
grep -q 'GreenGuard EBS volume from saved PV' "$STUB_DIR/out" && ok "only an exact saved PV volume is reported"

setup inventory-pv-missing
rm "$STUB_DIR/pv-ids"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "missing PV inventory must fail closed"; fi
grep -q 'PV inventory unavailable' "$STUB_DIR/out" && ok "missing PV inventory fails closed"

setup inventory-master-secret
master_secret_arn='arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-test'
echo "$master_secret_arn" >"$STUB_DIR/master_secret"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 "$master_secret_arn" >"$STUB_DIR/out" 2>&1; then fail "RDS-managed secret must fail the inventory"; fi
grep -q 'RDS-managed master secret still exists' "$STUB_DIR/out" && ok "RDS-managed master secret leftover is reported"

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
  grep -q 'Disposable private edge ALB' "$STUB_DIR/out" && ok "exact global edge and identity leftovers are reported"

setup inventory-edge-denied
touch "$STUB_DIR/edge_inventory_error"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "CloudFront inventory denial must fail"; fi
grep -q 'AccessDenied' "$STUB_DIR/out" && ok "CloudFront inventory errors fail closed"

setup inventory-cognito-domain-missing
touch "$STUB_DIR/cognito_domain_missing"
"$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1 || fail "missing Cognito hosted domain is clean"
grep -q 'no GreenGuard resources found' "$STUB_DIR/out" && ok "missing Cognito hosted domain is a clean inventory"

setup inventory-master-secret-missing
"$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 "$master_secret_arn" >"$STUB_DIR/out" 2>&1 || fail "deleted RDS-managed secret should pass"
grep -q 'no GreenGuard resources found' "$STUB_DIR/out" && ok "deleted RDS-managed master secret passes"

setup neighbor
echo /aws/lambda/greenguard-escalation-mirror-sandbox-old >"$STUB_DIR/logs"
"$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1 || fail "neighbor log group is ignored"
grep -q "no GreenGuard resources found" "$STUB_DIR/out" && ok "post-destroy check ignores a neighboring environment log group"

setup dirty
printf 'arn:aws:ec2:us-east-1:1:natgateway/nat-1\tarn:aws:kms:us-east-1:1:key/k\n' >"$STUB_DIR/tagged"
touch "$STUB_DIR/cluster"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "dirty account fails"; fi
grep -q "natgateway/nat-1" "$STUB_DIR/out" && grep -q "EKS cluster" "$STUB_DIR/out" &&
  ! grep -q "KMS key not scheduled" "$STUB_DIR/out" && ok "post-destroy check reports leftovers and ignores pending KMS keys"

setup inventory-wrong-account
echo 999999999999 >"$STUB_DIR/account"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "inventory in a different account fails"; fi
grep -q "expected 123456789012" "$STUB_DIR/out" &&
  ! grep -q "resourcegroupstaggingapi" "$STUB_DIR/calls" && ok "inventory refuses a different account before listing resources"

setup inventory-flow-log
echo /aws/vpc/greenguard-sandbox-cell-1/flow >"$STUB_DIR/logs"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "VPC flow log remains"; fi
grep -q "/aws/vpc/greenguard-sandbox-cell-1/flow" "$STUB_DIR/out" && ok "inventory reports an exact VPC flow log"

setup inventory-tagging-denied
touch "$STUB_DIR/tagging_error"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "tagging API failure must fail the inventory"; fi
grep -q "AccessDenied" "$STUB_DIR/out" && ok "tagging API failure cannot pass as an empty inventory"

setup wrapper-clean
GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1 || fail "verified destroy wrapper succeeds on empty inventory"
grep -q '^terraform destroy$' "$STUB_DIR/calls" &&
  [ "$(grep -c '^aws sts get-caller-identity' "$STUB_DIR/calls")" -eq 3 ] &&
  [ "$(grep -n '^aws sts get-caller-identity' "$STUB_DIR/calls" | head -n 1 | cut -d: -f1)" -lt "$(grep -n '^terraform destroy$' "$STUB_DIR/calls" | cut -d: -f1)" ] &&
  ok "verified wrapper pre-cleans, destroys, then inventories"

setup wrapper-partial-apply
touch "$STUB_DIR/identity_error" "$STUB_DIR/cluster"
printf '%s\n' '{"values":{"root_module":{"resources":[{"address":"aws_eks_cluster.cell","mode":"managed","values":{"arn":"arn:aws:eks:us-east-1:123456789012:cluster/greenguard-sandbox-cell-1","name":"greenguard-sandbox-cell-1","tags_all":{"Project":"GreenGuard","Environment":"sandbox"}}}]}}}' >"$STUB_DIR/show_state"
GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1 || fail "partial apply with EKS state identity should clean up"
grep -q '^terraform show -json$' "$STUB_DIR/calls" &&
  grep -q 'kubectl .*delete pvc --all' "$STUB_DIR/calls" &&
  grep -q '^terraform destroy$' "$STUB_DIR/calls" &&
  ok "partial apply recovers EKS scope and pre-cleans before destroy"

setup wrapper-pre-cleanup-fails
touch "$STUB_DIR/cluster" "$STUB_DIR/api_unreachable"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "unreachable Kubernetes API must block Terraform destroy"; fi
grep -q 'EKS API is unreachable' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "pre-cleanup failure preserves Terraform state/resources"

setup wrapper-partial-rds-secret-missing
touch "$STUB_DIR/identity_error"
printf '%s\n' '{"values":{"root_module":{"resources":[{"address":"aws_eks_cluster.cell","mode":"managed","values":{"arn":"arn:aws:eks:us-east-1:123456789012:cluster/greenguard-sandbox-cell-1","name":"greenguard-sandbox-cell-1","tags_all":{"Project":"GreenGuard","Environment":"sandbox"}}},{"address":"aws_db_instance.postgres","mode":"managed","values":{"master_user_secret":[]}}]}}}' >"$STUB_DIR/show_state"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "partial RDS state without master secret ARN must stop destroy"; fi
grep -q 'RDS master secret ARN is unavailable' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "partial state preserves RDS secret inventory requirement"

setup wrapper-invalid-output-identity
printf '%s\n' '{"region":"invalid","environment":"sandbox","cluster_name":"greenguard-sandbox-cell-1","account_id":"123456789012"}' >"$STUB_DIR/identity"
printf '%s\n' '{"values":{"root_module":{"resources":[{"address":"aws_eks_cluster.cell","mode":"managed","values":{"arn":"arn:aws:eks:us-east-1:123456789012:cluster/greenguard-sandbox-cell-1","name":"greenguard-sandbox-cell-1","tags_all":{"Project":"GreenGuard","Environment":"sandbox"}}}]}}}' >"$STUB_DIR/show_state"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "invalid output identity must not fall back to partial state"; fi
grep -q 'invalid Terraform state identity' "$STUB_DIR/out" &&
  ! grep -q '^terraform show -json$' "$STUB_DIR/calls" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "invalid saved identity refuses partial-state fallback"

setup wrapper-terraform-fails
touch "$STUB_DIR/terraform_error"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "Terraform failure must stop wrapper"; fi
[ "$(grep -c '^aws sts get-caller-identity' "$STUB_DIR/calls")" -eq 1 ] && ok "verified wrapper does not run inventory after failed destroy"

setup wrapper-inventory-fails
echo 'arn:aws:ec2:us-east-1:1:natgateway/nat-1' >"$STUB_DIR/tagged"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "remaining resource must fail wrapper"; fi
grep -q 'natgateway/nat-1' "$STUB_DIR/out" && ok "verified wrapper fails when inventory finds a resource"

setup wrapper-master-secret
echo "$master_secret_arn" >"$STUB_DIR/master_secret_output"
echo "$master_secret_arn" >"$STUB_DIR/master_secret"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "remaining RDS-managed secret must fail wrapper"; fi
grep -q 'RDS-managed master secret still exists' "$STUB_DIR/out" &&
  grep -q 'secretsmanager describe-secret' "$STUB_DIR/calls" && ok "verified wrapper retains and checks RDS master secret ARN"

setup wrapper-master-secret-wrong-account
echo 'arn:aws:secretsmanager:us-east-1:999999999999:secret:rds!db-test' >"$STUB_DIR/master_secret_output"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "foreign RDS master secret ARN must stop destroy"; fi
grep -q 'does not match saved region/account' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "verified wrapper refuses mismatched RDS secret ARN"

setup wrapper-master-secret-empty
: >"$STUB_DIR/master_secret_output"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "empty RDS master secret output must stop destroy"; fi
grep -q 'invalid RDS master secret output' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "verified wrapper refuses an empty present RDS secret output"

setup wrapper-mismatched-scope
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" us-west-2 sandbox greenguard-sandbox-cell-1 123456789012 >"$STUB_DIR/out" 2>&1; then fail "mismatched inventory region must fail"; fi
grep -q 'do not match' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "verified wrapper rejects region mismatches before destroy"

setup wrapper-missing-identity
touch "$STUB_DIR/identity_error"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "missing identity must fail"; fi
grep -q 'cannot recover a unique cell identity from partial state' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "verified wrapper refuses missing state identity"

setup wrapper-output-error
touch "$STUB_DIR/output_error"
if GG_TERRAFORM_BIN="$work/terraform" "$here/destroy-verified.sh" >"$STUB_DIR/out" 2>&1; then fail "Terraform output error must stop destroy"; fi
grep -q 'Terraform state outputs unavailable' "$STUB_DIR/out" &&
  ! grep -q '^terraform destroy$' "$STUB_DIR/calls" && ok "verified wrapper fails closed on state output read error"

echo "teardown tests: $pass passed"
[ "$pass" -eq 40 ]
