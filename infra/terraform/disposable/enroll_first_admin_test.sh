#!/usr/bin/env bash
# Offline boundary tests: Terraform, AWS identity and npm are stubbed.
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
  'output -json secret_arns') cat "$STUB_DIR/secrets" ;;
  *) exit 1 ;;
esac
EOF
cat >"$work/aws" <<'EOF'
#!/usr/bin/env bash
echo "aws $*" >>"$STUB_DIR/calls"
case "$*" in
  'sts get-caller-identity --query Account --output text') cat "$STUB_DIR/account" ;;
  'secretsmanager get-secret-value --region us-east-1 --secret-id arn:aws:secretsmanager:us-east-1:123456789012:secret:greenguard/sandbox/tenant-control-plane-config-Ab12Cd --query SecretString --output text') cat "$STUB_DIR/runtime-secret" ;;
  *) exit 1 ;;
esac
EOF
cat >"$work/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" >>"$STUB_DIR/calls"
cat >"$STUB_DIR/token"
printf '%s\n' "$AUTH_ISSUER" "$AUTH_AUDIENCE" "$AUTH_JWKS_URL" "$ENROLL_TENANT_ID" "$ENROLL_CONFIRM" >"$STUB_DIR/enrollment"
printf '%s' "$CONTROL_DIRECT_URL" >"$STUB_DIR/database-url"
EOF
chmod +x "$work/terraform" "$work/aws" "$work/npm"
printf '%s\n' '{"region":"us-east-1","environment":"sandbox","cluster_name":"greenguard-sandbox","account_id":"123456789012"}' >"$work/cell"
printf '%s\n' '{"issuer":"https://id.example.test/","jwks_url":"https://id.example.test/.well-known/jwks.json","audience":"greenguard-api","bff_token_mode":"audience","bff_allowed_client_ids":[]}' >"$work/oidc"
printf '%s\n' '{"tenant-control-plane-config":"arn:aws:secretsmanager:us-east-1:123456789012:secret:greenguard/sandbox/tenant-control-plane-config-Ab12Cd"}' >"$work/secrets"
printf '%s' '{"CONTROL_DATABASE_URL":"postgresql://control_app:fixture@control.db.example.rds.amazonaws.com:5432/greenguard_control?sslmode=verify-full"}' >"$work/runtime-secret"
printf '%s\n' '123456789012' >"$work/account"
printf '%s\n' 'signed-access-token-fixture' >"$work/access-token"
chmod 600 "$work/access-token"

run() { GG_TERRAFORM_BIN="$work/terraform" "$here/enroll-first-admin.sh" "$@" >"$work/out" 2>&1; }
fail() { echo "not ok - $1" >&2; cat "$work/out" >&2; exit 1; }
pass=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
tenant='00000000-0000-4000-8000-000000000002'

run --enroll "$tenant" --token-file "$work/access-token" --confirm "${tenant}:https://id.example.test/" || fail 'existing OIDC token enrollment dispatch succeeds'
grep -q '^npm run enroll:oidc -w @greenguard/tenant-control-plane$' "$work/calls" &&
  grep -q '^https://id.example.test/$' "$work/enrollment" &&
  grep -q '^greenguard-api$' "$work/enrollment" &&
  grep -q "^${tenant}:https://id.example.test/$" "$work/enrollment" &&
  grep -q '^aws secretsmanager get-secret-value --region us-east-1 --secret-id arn:aws:secretsmanager:us-east-1:123456789012:secret:greenguard/sandbox/tenant-control-plane-config-Ab12Cd --query SecretString --output text$' "$work/calls" &&
  [ "$(cat "$work/database-url")" = 'postgresql://control_app:fixture@control.db.example.rds.amazonaws.com:5432/greenguard_control?sslmode=verify-full' ] &&
  cmp -s "$work/token" "$work/access-token" && ok 'issuer, audience and private stdin token reach verifier without argv exposure'

if run --enroll "$tenant" --token-file "$work/access-token" --confirm "${tenant}:https://wrong.example/"; then fail 'confirmation mismatch refused'; fi
grep -q 'confirmation must exactly match' "$work/out" && ok 'operator must confirm exact tenant and OIDC issuer'

chmod 644 "$work/access-token"
if run --enroll "$tenant" --token-file "$work/access-token" --confirm "${tenant}:https://id.example.test/"; then fail 'world-readable token file refused'; fi
grep -q 'mode 0600 or stricter' "$work/out" && ok 'unsafe token-file permissions refused'
chmod 600 "$work/access-token"

printf '%s\n' '999999999999' >"$work/account"
if run --enroll "$tenant" --token-file "$work/access-token" --confirm "${tenant}:https://id.example.test/"; then fail 'foreign account refused'; fi
grep -q 'does not match Terraform state' "$work/out" && ok 'wrong AWS account is refused'
printf '%s\n' '123456789012' >"$work/account"

printf '%s\n' '{"region":"us-east-1","environment":"production","cluster_name":"greenguard-prod","account_id":"123456789012"}' >"$work/cell"
if run --enroll "$tenant" --token-file "$work/access-token" --confirm "${tenant}:https://id.example.test/"; then fail 'production refused'; fi
grep -q 'refusing production' "$work/out" && ok 'production state is refused before AWS identity lookup'
printf '%s\n' '{"region":"us-east-1","environment":"sandbox","cluster_name":"greenguard-sandbox","account_id":"123456789012"}' >"$work/cell"

printf '%s' '{"KAFKA_BROKERS":"broker"}' >"$work/runtime-secret"
: >"$work/calls"
if run --enroll "$tenant" --token-file "$work/access-token" --confirm "${tenant}:https://id.example.test/"; then fail 'missing direct database URL refused'; fi
grep -q 'no verified-TLS database URL' "$work/out" && ! grep -q '^npm ' "$work/calls" && ok 'missing control database URL stops before invoking enrollment'
printf '%s' '{"CONTROL_DATABASE_URL":"postgresql://control_app:fixture@control.db.example.rds.amazonaws.com:5432/greenguard_control?sslmode=verify-full"}' >"$work/runtime-secret"

printf '%s\n' '{"issuer":"https://id.example.test/","jwks_url":"https://id.example.test/.well-known/jwks.json","audience":"","bff_token_mode":"audience","bff_allowed_client_ids":[]}' >"$work/oidc"
if run --enroll "$tenant" --token-file "$work/access-token" --confirm "${tenant}:https://id.example.test/"; then fail 'missing OIDC audience refused'; fi
grep -q 'requires its configured API audience' "$work/out" && ok 'OIDC audience is mandatory'

echo "enroll-first-admin tests: $pass passed"
[ "$pass" -eq 7 ]
