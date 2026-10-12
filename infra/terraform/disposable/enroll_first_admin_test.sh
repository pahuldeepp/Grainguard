#!/usr/bin/env bash
# Offline enrollment boundary tests. Every AWS/kubectl/terraform command is stubbed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export STUB_DIR="$work" PATH="$work:$PATH"

cat >"$work/terraform" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  'output -json disposable_cell_identity') cat "$STUB_DIR/cell" ;;
  'output -json oidc_public_configuration') cat "$STUB_DIR/oidc" ;;
  *) exit 2 ;;
esac
EOF
cat >"$work/aws" <<'EOF'
#!/usr/bin/env bash
printf 'aws %s\n' "$*" >>"$STUB_DIR/calls"
case "$*" in
  'sts get-caller-identity --query Account --output text') cat "$STUB_DIR/account" ;;
  'eks update-kubeconfig --region us-east-1 --name greenguard-sandbox --kubeconfig '* )
    for arg in "$@"; do case "$arg" in --kubeconfig) next=1 ;; *) if [ "${next:-}" = 1 ]; then printf 'stub kubeconfig\n' >"$arg"; unset next; fi ;; esac; done ;;
  'eks describe-cluster --region us-east-1 --name greenguard-sandbox --output json') cat "$STUB_DIR/cluster" ;;
  *) exit 2 ;;
esac
EOF
cat >"$work/kubectl" <<'EOF'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >>"$STUB_DIR/calls"
case "$*" in
  *' config view --minify --raw -o json') cat "$STUB_DIR/kubeconfig-view" ;;
  *' get --raw=/readyz') printf 'ok\n' ;;
  *' get pods --namespace greenguard --selector app.kubernetes.io/instance=tenant-control-plane -o json') cat "$STUB_DIR/pods" ;;
  *' exec --namespace greenguard --stdin '* )
    printf '%s\n' "$*" >"$STUB_DIR/exec-args"
    cat >"$STUB_DIR/token"
    if [[ "$*" == *'ENROLL_OUTPUT_FORMAT=json'* ]]; then cat "$STUB_DIR/receipt"; else
      printf '%s\n' 'OIDC first-admin enrollment: ACTIVE admin membership read-back verified (queued)'; fi ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$work/terraform" "$work/aws" "$work/kubectl"
printf '%s\n' '{"region":"us-east-1","environment":"sandbox","cluster_name":"greenguard-sandbox","account_id":"123456789012"}' >"$work/cell"
printf '%s\n' '{"issuer":"https://id.example.test/","jwks_url":"https://id.example.test/.well-known/jwks.json","audience":"greenguard-api","bff_token_mode":"audience","bff_allowed_client_ids":[]}' >"$work/oidc"
printf '%s\n' '123456789012' >"$work/account"
printf '%s\n' '{"cluster":{"arn":"arn:aws:eks:us-east-1:123456789012:cluster/greenguard-sandbox","status":"ACTIVE","endpoint":"https://example.eks.amazonaws.com","certificateAuthority":{"data":"Y2E="}}}' >"$work/cluster"
printf '%s\n' '{"clusters":[{"cluster":{"server":"https://example.eks.amazonaws.com","certificate-authority-data":"Y2E="}}]}' >"$work/kubeconfig-view"
printf '%s\n' '{"items":[{"metadata":{"name":"tenant-control-plane-abc","labels":{"app.kubernetes.io/instance":"tenant-control-plane"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}],"containerStatuses":[{"name":"tenant-control-plane","ready":true,"imageID":"containerd://sha256:abc","state":{"running":{}}}]}}]}' >"$work/pods"
printf '%s\n' 'signed-access-token-fixture' >"$work/access-token"
chmod 600 "$work/access-token"

tenant='00000000-0000-4000-8000-000000000002'
run() { GG_TERRAFORM_BIN="$work/terraform" GG_AWS_BIN="$work/aws" GG_KUBECTL_BIN="$work/kubectl" "$here/enroll-first-admin.sh" --enroll "$tenant" --token-file "$work/access-token" --confirm "$1" >"$work/out" 2>&1; }
pass=0
ok() { pass=$((pass+1)); echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; cat "$work/out" >&2; exit 1; }

run "${tenant}:https://id.example.test/" || fail 'safe exact-cell enrollment reaches runtime verifier'
cmp -s "$work/token" "$work/access-token" &&
  ! grep -Fq 'signed-access-token-fixture' "$work/exec-args" &&
  ! grep -q 'secretsmanager\|CONTROL_DATABASE_URL\|secret_arns' "$work/calls" &&
  grep -q 'node /app/services/tenant-control-plane/dist/enroll-first-admin-cli.js' "$work/exec-args" &&
  ok 'token is passed only over stdin; host never fetches credentials or database URL'

if run "${tenant}:https://wrong.example/"; then fail 'issuer confirmation mismatch should fail'; fi
grep -q 'confirmation must exactly match' "$work/out" && ok 'operator confirms exact tenant and configured issuer'

chmod 644 "$work/access-token"
if run "${tenant}:https://id.example.test/"; then fail 'unsafe token permissions should fail'; fi
grep -q 'mode 0600 or stricter' "$work/out" && ok 'unsafe token file permissions are rejected'
chmod 600 "$work/access-token"

printf '%s\n' '999999999999' >"$work/account"
if run "${tenant}:https://id.example.test/"; then fail 'foreign AWS account should fail'; fi
grep -q 'does not match Terraform cell state' "$work/out" && ok 'account mismatch is rejected before cluster access'
printf '%s\n' '123456789012' >"$work/account"

printf '%s\n' '{"region":"us-east-1","environment":"production","cluster_name":"greenguard-prod","account_id":"123456789012"}' >"$work/cell"
if run "${tenant}:https://id.example.test/"; then fail 'production cell should fail'; fi
grep -q 'refusing production' "$work/out" && ok 'production cell is refused'
printf '%s\n' '{"region":"us-east-1","environment":"sandbox","cluster_name":"greenguard-sandbox","account_id":"123456789012"}' >"$work/cell"

printf '%s\n' '{"version":1,"tenant_id":"00000000-0000-4000-8000-000000000002","user_id":"11111111-1111-5111-8111-111111111111","issuer":"https://id.example.test/","role":"admin","state":"active","enrollment":"existing"}' >"$work/receipt"
GG_ENROLL_OUTPUT_FORMAT=json run "${tenant}:https://id.example.test/" || fail 'verified JSON receipt should pass'
cmp -s "$work/out" "$work/receipt" || fail 'JSON owner receipt does not match the verified runtime response'
ok 'JSON owner receipt is bound to exact tenant and issuer'
cp "$work/receipt" "$work/valid-receipt"
for field in tenant_id role user_id; do
  python3 - "$work/valid-receipt" "$work/receipt" "$field" <<'PYJSON'
import json,sys
with open(sys.argv[1]) as source: value=json.load(source)
value[sys.argv[3]]={"tenant_id":"22222222-2222-4222-8222-222222222222","role":"member","user_id":"not-an-identity"}[sys.argv[3]]
with open(sys.argv[2],"w") as target: json.dump(value,target)
PYJSON
  if GG_ENROLL_OUTPUT_FORMAT=json run "${tenant}:https://id.example.test/"; then fail "invalid receipt $field should fail"; fi
  ok "invalid receipt $field is rejected"
done

for malformed in null-issuer numeric-user array static-dex-id nil-identity; do
  python3 - "$work/valid-receipt" "$work/receipt" "$malformed" <<'PYJSON'
import json,sys
with open(sys.argv[1]) as source: value=json.load(source)
if sys.argv[3]=="array": value=[]
elif sys.argv[3]=="null-issuer": value["issuer"]=None
elif sys.argv[3]=="static-dex-id": value["user_id"]="11111111-1111-4111-8111-111111111111"
elif sys.argv[3]=="nil-identity": value["user_id"]="00000000-0000-0000-0000-000000000000"
else: value["user_id"]=42
with open(sys.argv[2],"w") as target: json.dump(value,target)
PYJSON
  if GG_ENROLL_OUTPUT_FORMAT=json run "${tenant}:https://id.example.test/"; then fail "malformed receipt $malformed should fail"; fi
  grep -q 'invalid verified owner receipt' "$work/out" && ! grep -q 'Traceback' "$work/out" || fail 'malformed receipt leaked traceback'
  ok "malformed receipt $malformed fails with a controlled error"
done

echo "enroll-first-admin tests: $pass passed"
[ "$pass" -eq 14 ]
