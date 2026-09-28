#!/usr/bin/env bash
# One operator command for pre-cleanup, Terraform destroy, and AWS inventory.
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

# Read the scope persisted by the last successful apply. A mode-0600 manifest
# is retained before destruction so a failed final inventory can be retried
# after Terraform has erased state.
pv_inventory_file="${GG_PV_INVENTORY_FILE:-$here/.last-destroy-pvs}"
manifest_file="${pv_inventory_file}.scope.json"
outputs_json="$("$terraform_bin" output -json 2>/dev/null)" || outputs_json=""
identity_file="$(mktemp)"
shard_secrets_file="$(mktemp)"
partial_state_json=""
trap 'rm -f "$identity_file" "$shard_secrets_file"' EXIT
manifest_recovery=false
if [ -f "$manifest_file" ] || [ -L "$manifest_file" ]; then
  state_json=""
  state_is_empty=false
  if state_json="$("$terraform_bin" show -json 2>/dev/null)"; then
    if printf '%s' "$state_json" | python3 -c '
import json, sys
def managed(module):
    if any(item.get("mode") == "managed" for item in module.get("resources", [])):
        return True
    return any(managed(child) for child in module.get("child_modules", []))
try:
    root = json.load(sys.stdin)["values"]["root_module"]
except (KeyError, TypeError, json.JSONDecodeError):
    raise SystemExit(1)
raise SystemExit(1 if managed(root) else 0)
'; then
      state_is_empty=true
    fi
  elif [ ! -s "$here/terraform.tfstate" ]; then
    state_is_empty=true
  fi
  if [ "$state_is_empty" = true ]; then
    [ "$#" -eq 4 ] || {
      echo "destroy-verified: Terraform state is empty; retry must provide the recorded region, environment, cluster and account" >&2
      exit 1
    }
    manifest_json="$(python3 "$here/destroy-scope-manifest.py" read "$manifest_file")" || {
      echo "destroy-verified: saved cleanup manifest is invalid; refusing recovery" >&2
      exit 1
    }
    printf '%s' "$manifest_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(" ".join([d["region"], d["environment"], d["cluster_name"], d["account_id"], d["master_secret_arn"]]))
' >"$identity_file"
    printf '%s' "$manifest_json" | python3 -c '
import json, sys
print("\n".join(json.load(sys.stdin)["shard_master_secret_arns"]))
' >"$shard_secrets_file"
    region="${1}"
    environment="${2}"
    cluster="${3}"
    account="${4}"
    manifest_recovery=true
  fi
fi

if [ "$manifest_recovery" != true ]; then
if printf '%s' "$outputs_json" | python3 -c '
import json, re, sys
outputs = json.load(sys.stdin)
if not isinstance(outputs, dict) or "disposable_cell_identity" not in outputs:
    raise SystemExit(42)
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
' >"$identity_file"; then
  :
else
  parse_status=$?
  if [ "$parse_status" -ne 42 ]; then
    echo "destroy-verified: invalid Terraform state identity; refusing partial-state recovery" >&2
    exit 1
  fi
  # Root outputs do not exist until apply completes. The scope resource is a
  # prerequisite of the VPC, so even a pre-EKS partial apply has a saved cell
  # identity. Older partial states can still recover from the exact EKS ARN.
  partial_state_json="$("$terraform_bin" show -json)"
  printf '%s' "$partial_state_json" | python3 -c '
import json, re, sys
try:
    state = json.load(sys.stdin)
    resources = state["values"]["root_module"]["resources"]
    scopes = [r["values"].get("input") for r in resources
              if r.get("address") == "terraform_data.cell_scope"
              and r.get("mode") == "managed"]
    if len(scopes) > 1:
        raise ValueError("multiple saved cell scopes")
    clusters = [r["values"] for r in resources
                if r.get("address") == "aws_eks_cluster.cell"
                and r.get("mode") == "managed"]
    if len(clusters) > 1:
        raise ValueError("multiple EKS clusters in partial state")
    if scopes:
        scope = scopes[0]
        if not isinstance(scope, dict):
            raise ValueError("invalid saved cell scope")
        region, environment, name, account = (scope.get(k) for k in
            ("region", "environment", "cluster_name", "account_id"))
        if (not isinstance(region, str) or not re.fullmatch(r"[a-z]{2}-[a-z]+-[0-9]+", region)
            or not isinstance(environment, str) or not re.fullmatch(r"[a-z][a-z0-9-]{1,15}", environment)
            or not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", name)
            or not isinstance(account, str) or not re.fullmatch(r"[0-9]{12}", account)):
            raise ValueError("invalid saved cell scope fields")
    elif clusters:
        cluster = clusters[0]
        match = re.fullmatch(r"arn:aws[a-z-]*:eks:([a-z]{2}-[a-z]+-[0-9]+):([0-9]{12}):cluster/([A-Za-z0-9][A-Za-z0-9_-]{0,99})", cluster["arn"])
        if not match or cluster.get("name") != match.group(3):
            raise ValueError("EKS cluster ARN/name mismatch")
        region, account, name = match.groups()
        environment = cluster["tags_all"]["Environment"]
        if not re.fullmatch(r"[a-z][a-z0-9-]{1,15}", environment) or cluster["tags_all"].get("Project") != "GreenGuard":
            raise ValueError("EKS cell tags are missing or invalid")
    else:
        raise ValueError("no saved cell scope or EKS identity")
    if clusters:
        cluster = clusters[0]
        expected = f"arn:aws:eks:{region}:{account}:cluster/{name}"
        if cluster.get("arn") != expected or cluster.get("name") != name:
            raise ValueError("EKS identity differs from saved cell scope")
        if cluster.get("tags_all", {}).get("Environment") != environment or cluster.get("tags_all", {}).get("Project") != "GreenGuard":
            raise ValueError("EKS tags differ from saved cell scope")
    vpcs = [r["values"] for r in resources if r.get("address") == "aws_vpc.cell" and r.get("mode") == "managed"]
    if len(vpcs) > 1 or (vpcs and (vpcs[0].get("tags_all", {}).get("Environment") != environment
        or vpcs[0].get("tags_all", {}).get("Project") != "GreenGuard"
        or vpcs[0].get("tags", {}).get("Name") != f"{name}-vpc")):
        raise ValueError("VPC tags differ from saved cell scope")
    secrets = [r["values"] for r in resources
               if r.get("address") == "aws_db_instance.postgres" and r.get("mode") == "managed"]
    if len(secrets) > 1:
        raise ValueError("multiple disposable RDS instances in partial state")
    secret_arn = ""
    if secrets:
        secret = secrets[0].get("master_user_secret")
        if not isinstance(secret, list) or len(secret) != 1 or not isinstance(secret[0].get("secret_arn"), str):
            raise ValueError("RDS master secret ARN is unavailable in partial state")
        secret_arn = secret[0]["secret_arn"]
    print(" ".join([region, environment, name, account, secret_arn]))
except (KeyError, TypeError, IndexError, ValueError) as exc:
    raise SystemExit(f"destroy-verified: cannot recover a unique cell identity from partial state: {exc}")
' >"$identity_file" || {
    echo "destroy-verified: retain state and inspect the partial apply before cleanup" >&2
    exit 1
  }
fi
read -r region environment cluster account master_secret_arn <"$identity_file"
environment_lower="$(printf '%s' "$environment" | tr '[:upper:]' '[:lower:]')"
if [ "$environment_lower" = prod ] || [ "$environment_lower" = production ]; then
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

# A failed update can leave older root outputs while new shard instances already
# exist in state. Always inspect the latest state when the recovery branch did
# not already read it; stale outputs alone cannot inventory managed secrets.
if [ -z "$partial_state_json" ]; then
  partial_state_json="$("$terraform_bin" show -json)" || {
    echo "destroy-verified: cannot inspect state for shard master secrets" >&2
    exit 1
  }
fi

# Retain all managed shard master secret ARNs before destroy erases outputs.
# Successful applies expose the registry; partial applies are recovered from
# the already-read state, with account/region validation before any deletion.
printf '%s\n%s' "$outputs_json" "${partial_state_json:-}" | python3 -c '
import json, re, sys
stream = sys.stdin.read()
outputs, offset = json.JSONDecoder().raw_decode(stream)
partial = json.loads(stream[offset:].strip() or "{}")
region, account = sys.argv[1:]
arns = []
if "postgres_shards" in outputs:
    registry = outputs["postgres_shards"].get("value")
    if not isinstance(registry, dict) or set(registry) != {"s1", "s2", "s3", "s4"}:
        raise SystemExit("destroy-verified: invalid shard registry output")
    for shard_id, shard in registry.items():
        if not isinstance(shard, dict):
            raise SystemExit("destroy-verified: invalid shard registry entry")
        arns.append(shard.get("master_secret_arn"))
resources = partial.get("values", {}).get("root_module", {}).get("resources", [])
for resource in resources:
    if resource.get("mode") == "managed" and resource.get("type") == "aws_db_instance" and resource.get("name") == "shard":
        secrets = resource.get("values", {}).get("master_user_secret")
        if not isinstance(secrets, list) or len(secrets) != 1:
            raise SystemExit("destroy-verified: shard master secret unavailable in partial state")
        arns.append(secrets[0].get("secret_arn"))
for arn in arns:
    if not isinstance(arn, str) or not re.fullmatch(r"arn:aws[a-z-]*:secretsmanager:" + re.escape(region) + ":" + account + ":secret:.+", arn):
        raise SystemExit("destroy-verified: shard master secret ARN does not match saved account/region")
print("\n".join(dict.fromkeys(arns)))
' "$region" "$account" >"$shard_secrets_file" || exit 1
fi

# Save the scope before pre-cleanup mutates anything. A failed destroy or
# failed post-destroy inventory deliberately leaves this owner-only manifest
# behind for an exact retry after Terraform state has disappeared.
if [ "$manifest_recovery" != true ]; then
  python3 "$here/destroy-scope-manifest.py" save "$manifest_file" \
    "$region" "$environment" "$cluster" "$account" "$master_secret_arn" "$shard_secrets_file" || {
      echo "destroy-verified: could not safely persist cleanup scope; refusing destroy" >&2
      exit 1
    }
fi
manifest_json="$(python3 "$here/destroy-scope-manifest.py" read "$manifest_file")" || {
  echo "destroy-verified: persisted cleanup manifest could not be reopened; refusing destroy" >&2
  exit 1
}
master_secret_arn="$(printf '%s' "$manifest_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["master_secret_arn"])')"
printf '%s' "$manifest_json" | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["shard_master_secret_arns"]))' >"$shard_secrets_file"

# Run this idempotent hook before Terraform destroy: an interrupted apply may
# not yet have created terraform_data.pre_destroy_cleanup, so relying on its
# destroy provisioner alone can strand controller-owned LBs and EBS volumes.
# The hook verifies AWS account and Kubernetes access before any deletion.
GG_CLUSTER="$cluster" GG_REGION="$region" GG_ENVIRONMENT="$environment" GG_ACCOUNT="$account" \
  GG_MASTER_SECRET_ARN="$master_secret_arn" \
  GG_PV_INVENTORY_FILE="$pv_inventory_file" \
  "$here/pre-destroy.sh"
GG_VERIFIED_DESTROY_SCOPE="${account}:${region}:${environment}:${cluster}" "$terraform_bin" destroy
GG_SHARD_MASTER_SECRET_ARNS="$(cat "$shard_secrets_file")" "$here/check-teardown.sh" "$region" "$environment" "$cluster" "$account" "$master_secret_arn" "$pv_inventory_file"
python3 "$here/destroy-scope-manifest.py" remove "$manifest_file"
