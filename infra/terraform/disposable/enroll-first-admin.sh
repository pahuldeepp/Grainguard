#!/usr/bin/env bash
# Enroll the verified OIDC token holder in the exact disposable cell. The token
# is passed only on stdin through kubectl exec to the running service container.
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
aws_bin="${GG_AWS_BIN:-aws}"
kubectl_bin="${GG_KUBECTL_BIN:-kubectl}"
for command_name in "$terraform_bin" "$aws_bin" "$kubectl_bin" python3; do
  command -v "$command_name" >/dev/null || { echo "enroll-first-admin: missing required command" >&2; exit 1; }
done
resolve_bin() {
  if [[ "$1" == */* ]]; then
    printf '%s/%s\n' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"
  else
    command -v "$1"
  fi
}
terraform_bin="$(resolve_bin "$terraform_bin")"
aws_bin="$(resolve_bin "$aws_bin")"
kubectl_bin="$(resolve_bin "$kubectl_bin")"

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
cd "$here"
"$terraform_bin" output -json disposable_cell_identity >"$work/cell.json"
"$terraform_bin" output -json oidc_public_configuration >"$work/oidc.json"
python3 - "$work/cell.json" "$work/oidc.json" "$token_file" >"$work/config" <<'PY'
import json, os, re, stat, sys
from urllib.parse import urlsplit
cell = json.load(open(sys.argv[1]))
oidc = json.load(open(sys.argv[2]))
st = os.stat(os.path.realpath(sys.argv[3]), follow_symlinks=False)
if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
    raise SystemExit('enroll-first-admin: token file must be owned by this user and have mode 0600 or stricter')
region, account, environment, cluster_name = (cell.get(k) for k in ('region', 'account_id', 'environment', 'cluster_name'))
if not re.fullmatch(r'[a-z]{2}-[a-z]+-[0-9]+', region or '') or str(environment).lower() in ('prod', 'production'):
    raise SystemExit('enroll-first-admin: refusing production or invalid disposable cell region')
if not re.fullmatch(r'[0-9]{12}', account or '') or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,99}', cluster_name or ''):
    raise SystemExit('enroll-first-admin: invalid disposable cell identity in Terraform state')
issuer, jwks, mode = oidc.get('issuer'), oidc.get('jwks_url'), oidc.get('bff_token_mode')
def https_url(value):
    if not isinstance(value, str): return False
    parsed = urlsplit(value)
    return parsed.scheme == 'https' and bool(parsed.hostname) and not parsed.username and not parsed.password
if not https_url(issuer) or not https_url(jwks):
    raise SystemExit('enroll-first-admin: Terraform state has no deployed HTTPS OIDC issuer/JWKS')
if mode not in ('audience', 'cognito-access'):
    raise SystemExit('enroll-first-admin: unsupported token validation mode')
audience, clients = oidc.get('audience') or '', oidc.get('bff_allowed_client_ids') or []
if mode == 'audience' and (not isinstance(audience, str) or not audience):
    raise SystemExit('enroll-first-admin: existing OIDC mode requires its configured API audience')
if not isinstance(clients, list) or any(not isinstance(v, str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,256}', v) for v in clients):
    raise SystemExit('enroll-first-admin: invalid OIDC public client allowlist')
if mode == 'cognito-access' and not clients:
    raise SystemExit('enroll-first-admin: Cognito access mode requires its public client allowlist')
if ',' in audience or any(',' in client for client in clients):
    raise SystemExit('enroll-first-admin: OIDC audience/client configuration contains an unsupported delimiter')
print(json.dumps({'region': region, 'account': account, 'cluster_name': cluster_name,
                  'issuer': issuer, 'jwks': jwks, 'audience': audience,
                  'token_mode': mode, 'clients': clients}))
PY
chmod 600 "$work/config" "$work/cell.json" "$work/oidc.json"

actual_account="$("$aws_bin" sts get-caller-identity --query Account --output text)"
expected_account="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["account"])' "$work/config")"
[ "$actual_account" = "$expected_account" ] || { echo "enroll-first-admin: current AWS account does not match Terraform cell state" >&2; exit 1; }
region="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["region"])' "$work/config")"
cluster_name="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["cluster_name"])' "$work/config")"
issuer="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["issuer"])' "$work/config")"
[ "$operator_confirmation" = "${tenant_id}:${issuer}" ] || { echo "enroll-first-admin: confirmation must exactly match the supplied tenant ID and configured OIDC issuer" >&2; exit 1; }

"$aws_bin" eks update-kubeconfig --region "$region" --name "$cluster_name" --kubeconfig "$work/kubeconfig" >/dev/null
[ -f "$work/kubeconfig" ] || { echo "enroll-first-admin: exact-cell kubeconfig could not be created" >&2; exit 1; }
chmod 600 "$work/kubeconfig"
"$aws_bin" eks describe-cluster --region "$region" --name "$cluster_name" --output json >"$work/cluster.json"
"$kubectl_bin" --kubeconfig "$work/kubeconfig" config view --minify --raw -o json >"$work/kubeconfig-view.json"
python3 - "$work/config" "$work/cluster.json" "$work/kubeconfig-view.json" <<'PY'
import json, sys
scope = json.load(open(sys.argv[1]))
cluster = json.load(open(sys.argv[2])).get('cluster', {})
view = json.load(open(sys.argv[3]))
expected = f"arn:aws:eks:{scope['region']}:{scope['account']}:cluster/{scope['cluster_name']}"
clusters = view.get('clusters', [])
if cluster.get('arn') != expected or cluster.get('status') != 'ACTIVE' or len(clusters) != 1:
    raise SystemExit('enroll-first-admin: EKS identity/status or temporary kubeconfig is not the selected cell')
actual = clusters[0].get('cluster', {})
ca = cluster.get('certificateAuthority', {}).get('data')
if (not cluster.get('endpoint') or not ca or actual.get('server') != cluster['endpoint']
        or actual.get('certificate-authority-data') != ca
        or actual.get('insecure-skip-tls-verify') or actual.get('tls-server-name')):
    raise SystemExit('enroll-first-admin: temporary kubeconfig endpoint or TLS trust differs from selected EKS cell')
PY

kubectl=("$kubectl_bin" --kubeconfig "$work/kubeconfig" --request-timeout=20s)
[ "$("${kubectl[@]}" get --raw=/readyz 2>/dev/null)" = "ok" ] || { echo "enroll-first-admin: selected private EKS API is not reachable from this operator host" >&2; exit 1; }
pod_timeout="${GG_ENROLL_POD_TIMEOUT_SECONDS:-300}"
[[ "$pod_timeout" =~ ^[0-9]+$ ]] && [ "$pod_timeout" -ge 10 ] && [ "$pod_timeout" -le 900 ] || { echo "enroll-first-admin: pod timeout must be an integer from 10 to 900 seconds" >&2; exit 1; }
deadline=$((SECONDS + pod_timeout))
pod=""
while [ "$SECONDS" -lt "$deadline" ]; do
  if pods_json="$("${kubectl[@]}" get pods --namespace greenguard --selector app.kubernetes.io/instance=tenant-control-plane -o json 2>/dev/null)"; then
    pod="$(python3 -c 'import json,sys
obj=json.load(sys.stdin); names=[]
for p in obj.get("items", []):
 m=p.get("metadata", {}); s=p.get("status", {}); labels=m.get("labels", {})
 if labels.get("app.kubernetes.io/instance") != "tenant-control-plane" or s.get("phase") != "Running": continue
 ready=any(c.get("type")=="Ready" and c.get("status")=="True" for c in s.get("conditions", []))
 runtime=any(c.get("name")=="tenant-control-plane" and c.get("ready") is True and c.get("state", {}).get("running") is not None and c.get("imageID") for c in s.get("containerStatuses", []))
 if ready and runtime and isinstance(m.get("name"), str): names.append(m["name"])
print(sorted(names)[0] if names else "")' <<<"$pods_json")"
    [ -n "$pod" ] && break
  fi
  sleep 2
done
[ -n "$pod" ] || { echo "enroll-first-admin: no Ready tenant-control-plane runtime pod became available before timeout" >&2; exit 1; }

wait_timeout="${GG_ENROLL_WAIT_TIMEOUT_SECONDS:-900}"
[[ "$wait_timeout" =~ ^[0-9]+$ ]] && [ "$wait_timeout" -ge 10 ] && [ "$wait_timeout" -le 3600 ] || { echo "enroll-first-admin: membership wait timeout must be an integer from 10 to 3600 seconds" >&2; exit 1; }
env_args=()
if ! python3 - "$work/config" "$tenant_id" "$operator_confirmation" "$wait_timeout" >"$work/runtime-env" <<'PY'
import json, sys
c=json.load(open(sys.argv[1]))
values={
 'ENROLL_TENANT_ID':sys.argv[2], 'ENROLL_ROLE':'admin', 'ENROLL_CONFIRM':sys.argv[3],
 'AUTH_ISSUER':c['issuer'], 'AUTH_JWKS_URL':c['jwks'], 'AUTH_AUDIENCE':c['audience'],
 'AUTH_TOKEN_MODE':c['token_mode'], 'AUTH_COGNITO_CLIENT_IDS':','.join(c['clients']),
 'ENROLL_WAIT_TIMEOUT_MS':str(int(sys.argv[4])*1000),
}
for key,value in values.items():
 if not isinstance(value,str) or any(ord(c) < 32 or ord(c) == 127 for c in value): raise SystemExit('enroll-first-admin: invalid public OIDC configuration')
 print(f'{key}={value}')
PY
then
  echo "enroll-first-admin: invalid runtime enrollment configuration" >&2
  exit 1
fi
while IFS= read -r line; do env_args+=("$line"); done <"$work/runtime-env"
[ "${#env_args[@]}" -eq 9 ] || { echo "enroll-first-admin: incomplete runtime enrollment configuration" >&2; exit 1; }

# Public OIDC settings may appear in process arguments. The private access
# token never does: local file -> kubectl stdin -> CLI stdin only.
if ! "${kubectl[@]}" exec --namespace greenguard --stdin "$pod" --container tenant-control-plane -- env "${env_args[@]}" node /app/services/tenant-control-plane/dist/enroll-first-admin-cli.js <"$token_file" >"$work/enrollment.out" 2>"$work/enrollment.err"; then
  echo "enroll-first-admin: token verification, tenant bootstrap or active-membership read-back failed; no admin access is reported" >&2
  exit 1
fi
grep -q '^OIDC first-admin enrollment: ACTIVE admin membership read-back verified ' "$work/enrollment.out" || { echo "enroll-first-admin: runtime did not confirm the active admin membership" >&2; exit 1; }
cat "$work/enrollment.out"
