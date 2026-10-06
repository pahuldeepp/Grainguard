#!/usr/bin/env bash
# Run after `terraform destroy` to find GreenGuard resources that still exist in
# the region, including ones whose state was lost. Exits 1 if any are found.
#   ./check-teardown.sh <region> <environment> <cluster-name> <account-id>
set -euo pipefail

preflight=false
if [ "${1:-}" = --preflight ]; then preflight=true; shift; fi
region="${1:?region}" environment="${2:?environment}" cluster="${3:?cluster name}" account="${4:?account ID}"
master_secret_arn="${5:-}"
pv_inventory="${6:-${GG_PV_INVENTORY_FILE:-$(dirname "$0")/.last-destroy-pvs}}"
export AWS_REGION="$region" AWS_PAGER=""
command -v aws >/dev/null || { echo "check-teardown: aws is required" >&2; exit 1; }
environment_lower="$(printf '%s' "$environment" | tr '[:upper:]' '[:lower:]')"
if [ "$environment_lower" = prod ] || [ "$environment_lower" = production ] || [[ ! "$account" =~ ^[0-9]{12}$ ]]; then
  echo "check-teardown: refusing production or invalid account ID" >&2
  exit 1
fi
if [ -n "$master_secret_arn" ] && [[ ! "$master_secret_arn" =~ ^arn:aws[a-z-]*:secretsmanager:${region}:${account}:secret: ]]; then
  echo "check-teardown: RDS master secret ARN does not match the requested region/account" >&2
  exit 1
fi
actual_account="$(aws sts get-caller-identity --query Account --output text)"
if [ "$actual_account" != "$account" ]; then
  echo "check-teardown: AWS identity is in account $actual_account, expected $account" >&2
  exit 1
fi
found=0

# These names mirror data-storage.tf. Query the services directly as well as
# the tagging API so a lost tag cannot hide a billable database or S3 bucket.
if command -v shasum >/dev/null 2>&1; then
  cell_hash="$(printf '%s' "$cluster" | shasum -a 256 | awk '{print substr($1,1,8)}')"
  ecr_cell_hash="$(printf '%s' "$cluster" | shasum -a 256 | awk '{print substr($1,1,16)}')"
elif command -v sha256sum >/dev/null 2>&1; then
  cell_hash="$(printf '%s' "$cluster" | sha256sum | awk '{print substr($1,1,8)}')"
  ecr_cell_hash="$(printf '%s' "$cluster" | sha256sum | awk '{print substr($1,1,16)}')"
else
  echo "check-teardown: shasum or sha256sum is required for exact data-resource inventory" >&2
  exit 1
fi
data_prefix="$(printf '%s' "$cluster" | tr '[:upper:]' '[:lower:]' | tr '_' '-')"
ecr_prefix="greenguard/${environment}/cell-${ecr_cell_hash}/"
postgres_name="gg-${data_prefix:0:42}-${cell_hash}-postgres"
bucket_prefix_length=$((34 - ${#region}))
if [ "$bucket_prefix_length" -lt 1 ]; then
  echo "check-teardown: region name is too long for the audit bucket naming contract" >&2
  exit 1
fi
audit_bucket="${data_prefix:0:bucket_prefix_length}-${cell_hash}-${account}-${region}-audit"
archive_prefix_length=$((29 - ${#region}))
if [ "$archive_prefix_length" -lt 1 ]; then
  echo "check-teardown: region name is too long for the telemetry archive bucket naming contract" >&2
  exit 1
fi
telemetry_archive_bucket="${data_prefix:0:archive_prefix_length}-${cell_hash}-${account}-${region}-telemetry"
notification_state_table="${data_prefix:0:42}-${cell_hash}-notification-state"

# Terraform's edge_name is a normalized prefix plus the first eight hex
# digits of SHA-1(cluster_name). Exact names catch global resources that the
# regional Resource Groups Tagging API may omit.
if command -v shasum >/dev/null 2>&1; then
  edge_hash="$(printf '%s' "$cluster" | shasum -a 1 | awk '{print substr($1,1,8)}')"
  cognito_hash="$(printf '%s' "${account}:${cluster}" | shasum -a 1 | awk '{print substr($1,1,24)}')"
elif command -v sha1sum >/dev/null 2>&1; then
  edge_hash="$(printf '%s' "$cluster" | sha1sum | awk '{print substr($1,1,8)}')"
  cognito_hash="$(printf '%s' "${account}:${cluster}" | sha1sum | awk '{print substr($1,1,24)}')"
else
  echo "check-teardown: shasum or sha1sum is required for edge inventory" >&2
  exit 1
fi
edge_name="${data_prefix:0:17}-${edge_hash}-edge"
cognito_prefix="gg-${cognito_hash}"

report() {
  local title="$1" items="$2"
  [ "$preflight" = true ] && return
  items="$(printf '%s\n' "$items" | tr '\t' '\n' | sed '/^$/d;/^None$/d')"
  [ -z "$items" ] && return
  found=1
  echo "== $title"
  echo "$items"
}

tagged() {
  aws resourcegroupstaggingapi get-resources --tag-filters "$@" \
    --query 'ResourceTagMappingList[].ResourceARN' --output text
}

exact_log_group() {
  aws logs describe-log-groups --log-group-name-prefix "$1" \
    --query "logGroups[?logGroupName=='$1'].logGroupName" --output text
}

# Query AWS before formatting the results. Keeping each query in a standalone
# assignment makes an API or permission error fatal under `set -e` instead of
# accidentally treating it as an empty inventory.
project_resources="$(tagged Key=Project,Values=GreenGuard "Key=Environment,Values=$environment")"
cluster_resources="$(tagged "Key=kubernetes.io/cluster/$cluster")"
load_balancer_resources="$(tagged "Key=elbv2.k8s.aws/cluster,Values=$cluster")"
eks_clusters="$(aws eks list-clusters --query "clusters[?@=='$cluster']" --output text)"
eks_logs="$(aws logs describe-log-groups --log-group-name-prefix "/aws/eks/$cluster" --query 'logGroups[].logGroupName' --output text)"
vpc_flow_log="$(exact_log_group "/aws/vpc/$cluster/flow")"
mirror_log="$(exact_log_group "/aws/lambda/greenguard-escalation-mirror-$environment")"
dispatch_log="$(exact_log_group "/aws/lambda/greenguard-notification-dispatch-$environment")"
elastic_ips="$(aws ec2 describe-addresses --filters "Name=tag:Environment,Values=$environment" Name=tag:Project,Values=GreenGuard \
  --query 'Addresses[].AllocationId' --output text)"
cell_vpcs="$(aws ec2 describe-vpcs --filters "Name=tag:Name,Values=${cluster}-vpc" --query 'Vpcs[].VpcId' --output text)"
cell_internet_gateways="$(aws ec2 describe-internet-gateways \
  --filters "Name=tag:Name,Values=${cluster}-igw" --query 'InternetGateways[].InternetGatewayId' --output text)"
cell_nat_gateways="$(aws ec2 describe-nat-gateways \
  --filter "Name=tag:Name,Values=${cluster}-nat-*" --query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text)"
cell_nat_eips="$(aws ec2 describe-addresses --filters "Name=tag:Name,Values=${cluster}-nat-*" \
  --query 'Addresses[].AllocationId' --output text)"
if postgres_instances="$(aws rds describe-db-instances --db-instance-identifier "$postgres_name" \
  --query 'DBInstances[].DBInstanceIdentifier' --output text 2>&1)"; then
  :
elif [[ "$postgres_instances" == *DBInstanceNotFound* ]]; then
  postgres_instances=""
else
  echo "check-teardown: PostgreSQL instance inventory failed: $postgres_instances" >&2
  exit 1
fi
postgres_snapshots="$(aws rds describe-db-snapshots --snapshot-type manual \
  --filters "Name=db-instance-id,Values=$postgres_name" --query 'DBSnapshots[].DBSnapshotIdentifier' --output text)"
# Query exact normalized shard namespace independent of tags/state. Includes
# all stable primaries and any configured replicas, including lost-state ones.
shard_prefix="gg-${data_prefix:0:36}-${cell_hash}-shard-"
shard_instances="$(aws rds describe-db-instances \
  --query "DBInstances[?starts_with(DBInstanceIdentifier, '$shard_prefix')].DBInstanceIdentifier" --output text)"
shard_snapshots="$(aws rds describe-db-snapshots --snapshot-type manual \
  --query "DBSnapshots[?starts_with(DBInstanceIdentifier, '$shard_prefix')].DBSnapshotIdentifier" --output text)"
if notification_state_table_found="$(aws dynamodb describe-table --table-name "$notification_state_table" \
  --query 'Table.TableName' --output text 2>&1)"; then
  :
elif [[ "$notification_state_table_found" == *ResourceNotFoundException* ]]; then
  notification_state_table_found=""
else
  echo "check-teardown: notification state DynamoDB inventory failed: $notification_state_table_found" >&2
  exit 1
fi

s3_buckets="$(aws s3api list-buckets --query 'Buckets[].Name' --output text)"
if ecr_repositories="$(aws ecr describe-repositories \
  --query "repositories[?starts_with(repositoryName, '${ecr_prefix}')].repositoryName" --output text 2>&1)"; then
  :
else
  echo "check-teardown: ECR repository inventory failed: $ecr_repositories" >&2
  exit 1
fi
if customer_secret_arns="$(aws secretsmanager list-secrets --include-planned-deletion \
  --query "SecretList[?starts_with(Name, 'greenguard/$environment/') && contains(not_null(Tags[?Key=='Cell'].Value, \`[]\`), '$cluster')].ARN" --output text 2>&1)"; then
  :
else
  echo "check-teardown: customer Secrets Manager inventory failed: $customer_secret_arns" >&2
  exit 1
fi
edge_albs="$(aws elbv2 describe-load-balancers --query "LoadBalancers[?LoadBalancerName=='$edge_name'].LoadBalancerArn" --output text)"
web_distributions="$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$cluster dashboard'].ARN" --output text)"
api_distributions="$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$cluster mobile BFF'].ARN" --output text)"
vpc_origins="$(aws cloudfront list-vpc-origins --query "VpcOriginList.Items[?Name=='$edge_name'].Arn" --output text)"
edge_waf="$(aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 --query "WebACLs[?Name=='$edge_name'].ARN" --output text)"
cognito_pools="$(aws cognito-idp list-user-pools --page-size 60 --query "UserPools[?Name=='${edge_name%-edge}-users'].Id" --output text)"
if cognito_domain_description="$(aws cognito-idp describe-user-pool-domain --domain "$cognito_prefix" \
  --query 'DomainDescription.UserPoolId' --output text 2>&1)"; then
  :
elif [[ "$cognito_domain_description" == *ResourceNotFoundException* ]]; then
  cognito_domain_description=""
else
  echo "check-teardown: Cognito hosted-domain inventory failed: $cognito_domain_description" >&2
  exit 1
fi

# The tagging API can briefly list deleted resources and always lists KMS keys
# pending deletion, which are not billed; KMS is reported separately below.
report "Resources tagged Project=GreenGuard, Environment=$environment" \
  "$(printf '%s\n' "$project_resources" | tr '\t' '\n' | grep -v ':kms:' || true)"
report "Resources tagged kubernetes.io/cluster/$cluster" \
  "$cluster_resources"
report "Resources tagged elbv2.k8s.aws/cluster=$cluster" \
  "$load_balancer_resources"
report "EKS cluster" \
  "$eks_clusters"
stack_error="$(mktemp)"
trap 'rm -f "$stack_error"' EXIT
if stack_name="$(aws cloudformation describe-stacks --stack-name "GreenGuardServerless-$environment" \
  --query 'Stacks[].StackName' --output text 2>"$stack_error")"; then
  report "CloudFormation stack" "$stack_name"
elif ! grep -q 'does not exist' "$stack_error"; then
  cat "$stack_error" >&2
  echo "check-teardown: CloudFormation inventory failed" >&2
  exit 1
fi
if [ -f "$pv_inventory" ]; then
  while IFS= read -r volume_id; do
    [ -n "$volume_id" ] || continue
    if [[ ! "$volume_id" =~ ^vol-[0-9a-f]+$ ]]; then
      echo "check-teardown: invalid saved EBS volume ID" >&2
      exit 1
    fi
    remaining_volume="$(aws ec2 describe-volumes --filters "Name=volume-id,Values=$volume_id" \
      --query 'Volumes[].VolumeId' --output text)"
    report "GreenGuard EBS volume from saved PV" "$remaining_volume"
  done <"$pv_inventory"
else
  report "PV inventory unavailable; exact untagged EBS proof cannot pass" "$pv_inventory"
fi
report "Log groups" \
  "$eks_logs
$vpc_flow_log
$mirror_log
$dispatch_log"
report "Unreleased Elastic IPs tagged Environment=$environment" \
  "$elastic_ips"
report "Disposable VPC" "$cell_vpcs"
report "Disposable internet gateway" "$cell_internet_gateways"
report "Disposable NAT gateways" "$cell_nat_gateways"
report "Disposable NAT gateway Elastic IPs" "$cell_nat_eips"
report "Disposable PostgreSQL instance" "$postgres_instances"
report "Disposable shard primaries and read replicas" "$shard_instances"
report "Disposable shard manual snapshots" "$shard_snapshots"
report "Disposable PostgreSQL manual snapshots" \
  "$postgres_snapshots"
report "Disposable audit export S3 bucket" \
  "$(printf '%s\n' "$s3_buckets" | tr '\t' '\n' | grep -Fx "$audit_bucket" || true)"
report "Disposable telemetry archive S3 bucket" \
  "$(printf '%s\n' "$s3_buckets" | tr '\t' '\n' | grep -Fx "$telemetry_archive_bucket" || true)"
report "Disposable notification state DynamoDB table" "$notification_state_table_found"
report "Terraform-owned ECR repositories for $environment/$cluster" "$ecr_repositories"
report "Disposable customer Secrets Manager containers" "$customer_secret_arns"
report "Disposable private edge ALB" "$edge_albs"
report "Disposable CloudFront distributions" "$web_distributions
$api_distributions"
report "Disposable CloudFront VPC origin" "$vpc_origins"
report "Disposable CloudFront WAF ACL" "$edge_waf"
report "Disposable Cognito user pool" "$cognito_pools"
report "Disposable Cognito hosted domain" "$cognito_domain_description"

if [ -n "$master_secret_arn" ]; then
  if secret_metadata="$(aws secretsmanager describe-secret --secret-id "$master_secret_arn" --query 'ARN' --output text 2>&1)"; then
    report "RDS-managed master secret still exists" "$secret_metadata"
  elif [[ "$secret_metadata" != *ResourceNotFoundException* ]]; then
    echo "check-teardown: RDS master secret inventory failed: $secret_metadata" >&2
    exit 1
  fi
fi

# The verified wrapper captures these RDS-managed secret ARNs before deleting
# state. RDS secret deletion is managed by RDS, so verify every shard explicitly.
while IFS= read -r shard_secret; do
  [ -n "$shard_secret" ] || continue
  if [[ ! "$shard_secret" =~ ^arn:aws[a-z-]*:secretsmanager:${region}:${account}:secret: ]]; then
    echo "check-teardown: shard master secret ARN does not match region/account" >&2
    exit 1
  fi
  if metadata="$(aws secretsmanager describe-secret --secret-id "$shard_secret" --query ARN --output text 2>&1)"; then
    report "RDS-managed shard master secret still exists" "$metadata"
  elif [[ "$metadata" != *ResourceNotFoundException* ]]; then
    echo "check-teardown: shard master secret inventory failed: $metadata" >&2
    exit 1
  fi
done <<< "${GG_SHARD_MASTER_SECRET_ARNS:-}"

for key in $(printf '%s\n' "$project_resources" | tr '\t' '\n' | grep ':kms:' || true); do
  if ! state="$(aws kms describe-key --key-id "$key" --query 'KeyMetadata.KeyState' --output text)"; then
    echo "check-teardown: KMS key inventory failed for $key" >&2
    exit 1
  fi
  [ "$state" = "PendingDeletion" ] || report "KMS key not scheduled for deletion" "$key ($state)"
done

if [ "$preflight" = true ]; then
  echo "check-teardown: inventory read permissions verified for $environment/$cluster in $region"
elif [ "$found" -eq 0 ]; then
  echo "check-teardown: no GreenGuard resources found for $environment/$cluster in $region"
else
  echo "check-teardown: resources remain; delete them through their owner, then rerun" >&2
  exit 1
fi
