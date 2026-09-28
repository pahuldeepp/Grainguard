#!/usr/bin/env bash
# Bind the holder of a verified OIDC access token to the first admin of a NEW
# tenant. The selected provider remains external; this script never creates an
# identity account and never stores a token in Terraform state or argv.
set -euo pipefail

usage() {
  echo "usage: $0 --enroll <new-tenant-uuid> --token-file <mode-0600-file> --confirm <tenant-uuid:exact-oidc-issuer>" >&2
  exit 2
}

[ "$#" -eq 6 ] && [ "$1" = "--enroll" ] && [ "$3" = "--token-file" ] && [ "$5" = "--confirm" ] || usage
tenant_id="$2" token_file="$4" operator_confirmation="$6"
[[ "$tenant_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || usage
[ -f "$token_file" ] && [ ! -L "$token_file" ] || { echo "enroll-first-admin: token file must be a regular, non-symlink file" >&2; exit 1; }

terraform_bin="${GG_TERRAFORM_BIN:-terraform}"
for command_name in "$terraform_bin" aws python3 npm; do
  command -v "$command_name" >/dev/null || { echo "enroll-first-admin: missing $command_name" >&2; exit 1; }
done
if [[ "$terraform_bin" == */* ]]; then
  terraform_bin="$(cd "$(dirname "$terraform_bin")" && pwd)/$(basename "$terraform_bin")"
else
  terraform_bin="$(command -v "$terraform_bin")"
fi
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$here"

"$terraform_bin" output -json disposable_cell_identity >"$work/cell.json"
"$terraform_bin" output -json oidc_public_configuration >"$work/oidc.json"
"$terraform_bin" output -json secret_arns >"$work/secrets.json"
python3 - "$work/cell.json" "$work/oidc.json" "$token_file" "$work/secrets.json" >"$work/config" <<'PY'
import json, os, re, stat, sys
cell = json.load(open(sys.argv[1]))
oidc = json.load(open(sys.argv[2]))
secrets = json.load(open(sys.argv[4]))
token_path = os.path.realpath(sys.argv[3])
st = os.stat(token_path, follow_symlinks=False)
if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
    raise SystemExit('enroll-first-admin: token file must be owned by this user and have mode 0600 or stricter')
region, account, environment = (cell.get(k) for k in ('region', 'account_id', 'environment'))
if not re.fullmatch(r'[a-z]{2}-[a-z]+-[0-9]+', region or '') or str(environment).lower() in ('prod', 'production'):
    raise SystemExit('enroll-first-admin: refusing production or invalid disposable cell region')
if not re.fullmatch(r'[0-9]{12}', account or ''):
    raise SystemExit('enroll-first-admin: invalid disposable AWS account in Terraform state')
issuer, jwks, token_mode = oidc.get('issuer'), oidc.get('jwks_url'), oidc.get('bff_token_mode')
if not isinstance(issuer, str) or not issuer.startswith('https://') or not isinstance(jwks, str) or not jwks.startswith('https://'):
    raise SystemExit('enroll-first-admin: Terraform state has no deployed HTTPS OIDC issuer/JWKS')
if token_mode not in ('audience', 'cognito-access'):
    raise SystemExit('enroll-first-admin: unsupported token validation mode')
audience = oidc.get('audience') or ''
clients = oidc.get('bff_allowed_client_ids') or []
if token_mode == 'audience' and not audience:
    raise SystemExit('enroll-first-admin: existing OIDC mode requires its configured API audience')
if token_mode == 'cognito-access' and not clients:
    raise SystemExit('enroll-first-admin: Cognito access mode requires its public client allowlist')
secret_arn = secrets.get('tenant-control-plane-config')
secret_pattern = rf'^arn:[a-z0-9-]+:secretsmanager:{re.escape(region)}:{account}:secret:greenguard/{re.escape(environment)}/tenant-control-plane-config-[A-Za-z0-9]+$'
if not isinstance(secret_arn, str) or not re.fullmatch(secret_pattern, secret_arn):
    raise SystemExit('enroll-first-admin: Terraform state has no exact disposable control-plane runtime Secret ARN')
print(json.dumps({'region': region, 'account': account, 'issuer': issuer, 'jwks': jwks,
                  'audience': audience, 'token_mode': token_mode, 'clients': clients,
                  'secret_arn': secret_arn}))
PY

actual_account="$(aws sts get-caller-identity --query Account --output text)"
expected_account="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["account"])' "$work/config")"
[ "$actual_account" = "$expected_account" ] || {
  echo "enroll-first-admin: AWS account $actual_account does not match Terraform state $expected_account" >&2
  exit 1
}
region="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["region"])' "$work/config")"
runtime_secret_arn="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["secret_arn"])' "$work/config")"
aws secretsmanager get-secret-value --region "$region" --secret-id "$runtime_secret_arn" \
  --query SecretString --output text >"$work/runtime-secret.json"
control_direct_url="$(python3 - "$work/runtime-secret.json" <<'PY'
import json, sys
try:
    secret = json.load(open(sys.argv[1]))
    url = secret.get('CONTROL_DATABASE_URL')
except Exception:
    url = None
if not isinstance(url, str) or not url.startswith('postgresql://') or 'sslmode=verify-full' not in url:
    raise SystemExit('enroll-first-admin: Terraform-owned control-plane Secret has no verified-TLS database URL')
print(url)
PY
)"
issuer="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["issuer"])' "$work/config")"
[ "$operator_confirmation" = "${tenant_id}:${issuer}" ] || {
  echo "enroll-first-admin: confirmation must exactly match ${tenant_id}:${issuer}" >&2
  exit 1
}
jwks="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["jwks"])' "$work/config")"
audience="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["audience"])' "$work/config")"
token_mode="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token_mode"])' "$work/config")"
clients="$(python3 -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["clients"]))' "$work/config")"

cd "$repo"
ENROLL_TENANT_ID="$tenant_id" ENROLL_ROLE=admin \
ENROLL_CONFIRM="$operator_confirmation" AUTH_ISSUER="$issuer" AUTH_JWKS_URL="$jwks" \
AUTH_AUDIENCE="$audience" AUTH_TOKEN_MODE="$token_mode" AUTH_COGNITO_CLIENT_IDS="$clients" \
CONTROL_DIRECT_URL="$control_direct_url" \
  npm run enroll:oidc -w @greenguard/tenant-control-plane <"$token_file"
