#!/usr/bin/env bash
# Bind a *confirmed, email-verified* Cognito person to the first admin of a
# new GreenGuard tenant. Terraform state supplies the exact account, region,
# issuer and pool; no password or user identity is stored there.
set -euo pipefail

usage() {
  echo "usage: $0 --verify-only <email> | --enroll <email> <new-tenant-uuid>" >&2
  exit 2
}

case "${1:-}" in
  --verify-only) [ "$#" -eq 2 ] || usage ;;
  --enroll) [ "$#" -eq 3 ] || usage ;;
  *) usage ;;
esac
mode="$1" email="$2" tenant_id="${3:-}"
[[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || usage
if [ "$mode" = --enroll ]; then
  [[ "$tenant_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || usage
  [ -n "${CONTROL_DIRECT_URL:-}" ] || { echo "enroll-first-admin: CONTROL_DIRECT_URL is required" >&2; exit 1; }
fi

terraform_bin="${GG_TERRAFORM_BIN:-terraform}"
for command_name in "$terraform_bin" aws python3; do
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
"$terraform_bin" output -raw cognito_user_pool_id >"$work/pool"
python3 - "$work/cell.json" "$work/oidc.json" "$work/pool" >"$work/scope" <<'PY'
import json, re, sys
cell = json.load(open(sys.argv[1]))
oidc = json.load(open(sys.argv[2]))
pool = open(sys.argv[3]).read().strip()
region, account, environment = (cell.get(k) for k in ('region', 'account_id', 'environment'))
if environment == 'prod' or not re.fullmatch(r'[a-z]{2}-[a-z]+-[0-9]+', region or ''):
    raise SystemExit('enroll-first-admin: refusing production or invalid region')
if not re.fullmatch(r'[0-9]{12}', account or '') or not re.fullmatch(re.escape(region) + r'_[A-Za-z0-9]+', pool):
    raise SystemExit('enroll-first-admin: invalid account or Cognito pool ID')
issuer = f'https://cognito-idp.{region}.amazonaws.com/{pool}'
if oidc.get('issuer') != issuer:
    raise SystemExit('enroll-first-admin: Terraform issuer does not match its Cognito pool')
print(region, account, pool, issuer)
PY
read -r region account pool issuer <"$work/scope"
actual_account="$(aws sts get-caller-identity --query Account --output text)"
[ "$actual_account" = "$account" ] || {
  echo "enroll-first-admin: AWS account $actual_account does not match Terraform state $account" >&2
  exit 1
}

aws cognito-idp admin-get-user --region "$region" --user-pool-id "$pool" \
  --username "$email" --output json >"$work/user.json"
python3 - "$work/user.json" "$email" >"$work/subject" <<'PY'
import json, re, sys
user = json.load(open(sys.argv[1]))
attrs = {a.get('Name'): a.get('Value') for a in user.get('UserAttributes', [])}
if user.get('Enabled') is not True or user.get('UserStatus') != 'CONFIRMED':
    raise SystemExit('enroll-first-admin: Cognito user must be enabled and CONFIRMED')
if attrs.get('email_verified') != 'true' or (attrs.get('email') or '').casefold() != sys.argv[2].casefold():
    raise SystemExit('enroll-first-admin: Cognito email must match and be verified')
sub = attrs.get('sub') or ''
if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', sub):
    raise SystemExit('enroll-first-admin: Cognito sub must be a lowercase UUID')
print(sub)
PY
subject="$(cat "$work/subject")"

if [ "$mode" = --verify-only ]; then
  echo "enroll-first-admin: confirmed Cognito user and verified email in account $account, pool $pool; subject $subject"
  exit 0
fi

command -v npm >/dev/null || { echo "enroll-first-admin: npm is required for enrollment" >&2; exit 1; }
cd "$repo"
ENROLL_ISSUER="$issuer" ENROLL_SUBJECT="$subject" ENROLL_TENANT_ID="$tenant_id" \
  ENROLL_ROLE=admin ENROLL_CONFIRM="${tenant_id}:${subject}" \
  npm run enroll:cognito -w @greenguard/tenant-control-plane
