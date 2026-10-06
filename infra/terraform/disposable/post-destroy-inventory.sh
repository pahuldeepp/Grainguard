#!/usr/bin/env bash
# Final inventory hook for terraform_data.destroy_inventory_sentinel.
set -euo pipefail

if [ "$#" -ne 6 ]; then
  echo "post-destroy-inventory: expected region environment cluster account manifest pv-inventory" >&2
  exit 2
fi
region="$1"
environment="$2"
cluster="$3"
account="$4"
manifest="$5"
pv_inventory="$6"
here="$(cd "$(dirname "$0")" && pwd)"

manifest_json="$(python3 "$here/destroy-scope-manifest.py" read "$manifest")" || {
  echo "post-destroy-inventory: saved destroy inventory is missing or invalid; refusing to accept destroy" >&2
  exit 1
}
printf '%s' "$manifest_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
expected = dict(zip(("region", "environment", "cluster_name", "account_id"), sys.argv[1:]))
if any(d.get(k) != v for k, v in expected.items()):
    raise SystemExit("post-destroy-inventory: saved scope differs from the sentinel state")
' "$region" "$environment" "$cluster" "$account"
master_secret_arn="$(printf '%s' "$manifest_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["master_secret_arn"])')"
shard_secret_arns="$(printf '%s' "$manifest_json" | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["shard_master_secret_arns"]))')"

# check-teardown fails closed on denied reads, missing dynamic PV inventory,
# or any remaining scoped AWS resource. Keep the manifest on failure so the
# final check can be retried after Terraform removes this sentinel from state.
GG_SHARD_MASTER_SECRET_ARNS="$shard_secret_arns" \
  "$here/check-teardown.sh" "$region" "$environment" "$cluster" "$account" "$master_secret_arn" "$pv_inventory"

# Secret ARNs are retained only while a failed final inventory needs a retry.
# Removing the scoped manifest after the successful inventory avoids stale
# state-derived secret IDs breaking a later apply or teardown in this cell.
python3 "$here/destroy-scope-manifest.py" remove "$manifest"
