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
    if [[ "$*" == *elasticloadbalancing* ]]; then
      n=$(cat "$STUB_DIR/lb_polls" 2>/dev/null || echo 0)
      if [ "$n" -gt 0 ]; then echo "arn:aws:elasticloadbalancing:r:1:loadbalancer/net/k8s/1"; echo $((n - 1)) >"$STUB_DIR/lb_polls"; fi
    else
      cat "$STUB_DIR/tagged" 2>/dev/null || true
    fi ;;
  "kms describe-key") echo PendingDeletion ;;
esac
exit 0
EOF
cat >"$work/kubectl" <<'EOF'
#!/usr/bin/env bash
echo "kubectl $*" >>"$STUB_DIR/calls"
[[ "$*" == *"get service"* ]] && printf 'ingress-nginx edge\n'
exit 0
EOF
cat >"$work/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$work/aws" "$work/kubectl" "$work/sleep"

setup() {
  export STUB_DIR="$work/$1"
  mkdir -p "$STUB_DIR"
  export PATH="$work:$PATH"
}
ok() { pass=$((pass + 1)); echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; cat "$STUB_DIR/calls" >&2 2>/dev/null || true; exit 1; }
run_pre() {
  GG_CLUSTER=greenguard-sandbox-cell-1 GG_REGION=us-east-1 GG_ENVIRONMENT="${1:-sandbox}" GG_ACCOUNT=123456789012 \
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
grep -q "kubectl .*delete pvc --all" "$calls" || fail "PVCs deleted"
[ "$(grep -c elasticloadbalancing "$calls")" -ge 4 ] || fail "polls until load balancers are gone"
ok "deletes CDK stack, Kubernetes LB owners and PVCs, then waits for load balancers"

setup nothing
run_pre || fail "no stack and no cluster is a clean no-op"
! grep -q "delete-stack\|kubectl" "$STUB_DIR/calls" && ok "skips stack and Kubernetes cleanup when absent"

setup stuck
echo 999 >"$STUB_DIR/lb_polls"
if run_pre sandbox 0; then fail "stuck load balancer fails the destroy"; fi
grep -q "load balancers still present" "$STUB_DIR/out" && ok "a load balancer that never goes away stops the destroy"

setup wrong-account
echo 999999999999 >"$STUB_DIR/account"
if run_pre; then fail "wrong account is refused"; fi
grep -q "expected 123456789012" "$STUB_DIR/out" && ! grep -q "delete-stack\|kubectl" "$STUB_DIR/calls" && ok "a different AWS account is refused before any deletion"

setup clean
"$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 >"$STUB_DIR/out" 2>&1 || fail "clean account passes"
grep -q "no GreenGuard resources found" "$STUB_DIR/out" && ok "post-destroy check passes on a clean account"

setup neighbor
echo /aws/lambda/greenguard-escalation-mirror-sandbox-old >"$STUB_DIR/logs"
"$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 >"$STUB_DIR/out" 2>&1 || fail "neighbor log group is ignored"
grep -q "no GreenGuard resources found" "$STUB_DIR/out" && ok "post-destroy check ignores a neighboring environment log group"

setup dirty
printf 'arn:aws:ec2:us-east-1:1:natgateway/nat-1\tarn:aws:kms:us-east-1:1:key/k\n' >"$STUB_DIR/tagged"
touch "$STUB_DIR/cluster"
if "$here/check-teardown.sh" us-east-1 sandbox greenguard-sandbox-cell-1 >"$STUB_DIR/out" 2>&1; then fail "dirty account fails"; fi
grep -q "natgateway/nat-1" "$STUB_DIR/out" && grep -q "EKS cluster" "$STUB_DIR/out" &&
  ! grep -q "KMS key not scheduled" "$STUB_DIR/out" && ok "post-destroy check reports leftovers and ignores pending KMS keys"

echo "teardown tests: $pass passed"
[ "$pass" -eq 8 ]
