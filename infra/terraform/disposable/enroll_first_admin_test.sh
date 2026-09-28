#!/usr/bin/env bash
# Fully offline tests: all Terraform, AWS and npm calls are stubbed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export STUB_DIR="$work"
export PATH="$work:$PATH"

cat >"$work/terraform" <<'EOF'
#!/usr/bin/env bash
echo "terraform $*" >>"$STUB_DIR/calls"
case "$*" in
  'output -json disposable_cell_identity') cat "$STUB_DIR/cell" ;;
  'output -json oidc_public_configuration') cat "$STUB_DIR/oidc" ;;
  'output -raw cognito_user_pool_id') cat "$STUB_DIR/pool" ;;
  *) exit 1 ;;
esac
EOF
cat >"$work/aws" <<'EOF'
#!/usr/bin/env bash
echo "aws $*" >>"$STUB_DIR/calls"
case "$1 $2" in
  'sts get-caller-identity') cat "$STUB_DIR/account" ;;
  'cognito-idp admin-get-user') cat "$STUB_DIR/user" ;;
  *) exit 1 ;;
esac
EOF
cat >"$work/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" >>"$STUB_DIR/calls"
printf '%s\n' "$ENROLL_ISSUER" "$ENROLL_SUBJECT" "$ENROLL_TENANT_ID" "$ENROLL_ROLE" "$ENROLL_CONFIRM" >"$STUB_DIR/enrollment"
EOF
chmod +x "$work/terraform" "$work/aws" "$work/npm"
printf '%s\n' '{"region":"us-east-1","environment":"sandbox","cluster_name":"greenguard-sandbox","account_id":"123456789012"}' >"$work/cell"
printf '%s\n' '{"issuer":"https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Abc123"}' >"$work/oidc"
printf '%s\n' 'us-east-1_Abc123' >"$work/pool"
printf '%s\n' '123456789012' >"$work/account"
printf '%s\n' '{"Enabled":true,"UserStatus":"CONFIRMED","UserAttributes":[{"Name":"email","Value":"owner@example.org"},{"Name":"email_verified","Value":"true"},{"Name":"sub","Value":"00000000-0000-4000-8000-000000000001"}]}' >"$work/user"

run() { GG_TERRAFORM_BIN="$work/terraform" "$here/enroll-first-admin.sh" "$@" >"$work/out" 2>&1; }
fail() { echo "not ok - $1" >&2; cat "$work/out" >&2; exit 1; }
pass=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }

run --verify-only owner@example.org || fail 'verified user is accepted'
grep -q 'confirmed Cognito user' "$work/out" && [ ! -f "$work/enrollment" ] && ok 'verification does not mutate membership'

ENROLL_SUBJECT='00000000-0000-4000-8000-000000000099' CONTROL_DIRECT_URL='postgresql://operator:unused@127.0.0.1/unused' run --enroll owner@example.org 00000000-0000-4000-8000-000000000002 || fail 'enrollment dispatch succeeds'
grep -q '^npm run enroll:cognito -w @greenguard/tenant-control-plane$' "$work/calls" &&
  grep -q '^https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Abc123$' "$work/enrollment" &&
  grep -q '^00000000-0000-4000-8000-000000000001$' "$work/enrollment" &&
  ! grep -q '00000000-0000-4000-8000-000000000099' "$work/enrollment" &&
  grep -q '^00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000001$' "$work/enrollment" && ok 'enrollment receives exact verified issuer, sub and tenant'

if run --enroll owner@example.org 00000000-0000-4000-8000-000000000002; then fail 'missing database connection refused'; fi
grep -q 'CONTROL_DIRECT_URL is required' "$work/out" && ok 'missing membership database connection is refused'

printf '%s\n' '999999999999' >"$work/account"
if run --verify-only owner@example.org; then fail 'foreign account refused'; fi
grep -q 'does not match Terraform state' "$work/out" && ok 'wrong AWS account is refused'
printf '%s\n' '123456789012' >"$work/account"

sed 's/"email_verified","Value":"true"/"email_verified","Value":"false"/' "$work/user" >"$work/user.next"
mv "$work/user.next" "$work/user"
if run --verify-only owner@example.org; then fail 'unverified email refused'; fi
grep -q 'must match and be verified' "$work/out" && ok 'unverified email is refused'

printf '%s\n' '{"region":"us-east-1","environment":"prod","cluster_name":"greenguard-prod","account_id":"123456789012"}' >"$work/cell"
if run --verify-only owner@example.org; then fail 'production refused'; fi
grep -q 'refusing production' "$work/out" && ok 'production state is refused before user lookup'

echo "enroll-first-admin tests: $pass passed"
[ "$pass" -eq 6 ]
