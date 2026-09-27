#!/usr/bin/env bash
# One operator command for Terraform destroy followed by an AWS inventory.
# Native `terraform destroy` cannot reliably run a final inventory after every
# managed resource: destroy provisioners run when their own resource is deleted,
# and future resources could be omitted from a dependency chain.
set -euo pipefail

if [ "$#" -ne 0 ] && [ "$#" -ne 4 ]; then
  echo "usage: $0 [<region> <environment> <cluster-name> <account-id>]" >&2
  exit 2
fi
terraform_bin="${GG_TERRAFORM_BIN:-terraform}"
command -v "$terraform_bin" >/dev/null || {
  echo "destroy-verified: Terraform executable not found: $terraform_bin" >&2
  exit 1
}
command -v python3 >/dev/null || {
  echo "destroy-verified: python3 is required" >&2
  exit 1
}
if [[ "$terraform_bin" == */* ]]; then
  terraform_bin="$(cd "$(dirname "$terraform_bin")" && pwd)/$(basename "$terraform_bin")"
else
  terraform_bin="$(command -v "$terraform_bin")"
fi
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

# Read the scope persisted by the last successful apply. This is more reliable
# than trusting typed inventory arguments after the Terraform state is empty.
outputs_json="$("$terraform_bin" output -json)" || {
  echo "destroy-verified: Terraform state outputs unavailable; retain state and inspect it before cleanup" >&2
  exit 1
}
identity_file="$(mktemp)"
trap 'rm -f "$identity_file"' EXIT
printf '%s' "$outputs_json" | python3 -c '
import json, re, sys
outputs = json.load(sys.stdin)
if not isinstance(outputs, dict) or "disposable_cell_identity" not in outputs:
    raise SystemExit("destroy-verified: missing state identity output")
identity = outputs["disposable_cell_identity"]
if not isinstance(identity, dict) or "value" not in identity:
    raise SystemExit("destroy-verified: invalid state identity output")
d = identity["value"]
keys = ("region", "environment", "cluster_name", "account_id")
if not isinstance(d, dict) or any(not isinstance(d.get(k), str) for k in keys):
    raise SystemExit("destroy-verified: invalid Terraform identity output")
if not re.fullmatch(r"[a-z]{2}-[a-z]+-[0-9]+", d["region"]):
    raise SystemExit("destroy-verified: invalid region in state identity")
if not re.fullmatch(r"[a-z][a-z0-9-]{1,15}", d["environment"]):
    raise SystemExit("destroy-verified: invalid environment in state identity")
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", d["cluster_name"]):
    raise SystemExit("destroy-verified: invalid cluster in state identity")
if not re.fullmatch(r"[0-9]{12}", d["account_id"]):
    raise SystemExit("destroy-verified: invalid account in state identity")
secret = ""
if "postgres_master_secret_arn" in outputs:
    item = outputs["postgres_master_secret_arn"]
    if not isinstance(item, dict) or not isinstance(item.get("value"), str) or not item["value"]:
        raise SystemExit("destroy-verified: invalid RDS master secret output")
    secret = item["value"]
print(" ".join([*(d[k] for k in keys), secret]))
' >"$identity_file"
read -r region environment cluster account master_secret_arn <"$identity_file"
if [ "$environment" = prod ]; then
  echo "destroy-verified: refusing production" >&2
  exit 1
fi
if [ "$#" -eq 4 ] && { [ "$1" != "$region" ] || [ "$2" != "$environment" ] || [ "$3" != "$cluster" ] || [ "$4" != "$account" ]; }; then
  echo "destroy-verified: arguments do not match the Terraform state identity" >&2
  exit 1
fi

# Capture the RDS-managed master secret ARN from the same successful state
# read. Its absence is valid only for an older foundation-only state; a
# present but malformed value must stop destroy before state is erased.
if [ -n "$master_secret_arn" ] && [[ ! "$master_secret_arn" =~ ^arn:aws[a-z-]*:secretsmanager:${region}:${account}:secret: ]]; then
  echo "destroy-verified: RDS master secret ARN does not match saved region/account; refusing destroy" >&2
  exit 1
fi

# The provider's allowed_account_ids and pre-destroy hook enforce the target
# account during Terraform cleanup. The inventory checks the explicit account
# again after the state resources are gone.
"$terraform_bin" destroy
"$here/check-teardown.sh" "$region" "$environment" "$cluster" "$account" "$master_secret_arn" "${GG_PV_INVENTORY_FILE:-$here/.last-destroy-pvs}"
