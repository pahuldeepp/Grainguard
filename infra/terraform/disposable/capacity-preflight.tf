# Read-only quota metadata is resolved during plan, before billable creation.
# This checks configured maxima, not live utilization or instance availability.
data "aws_servicequotas_service_quota" "standard_vcpus" {
  service_code = "ec2"
  quota_code   = "L-1216C47A"
}

data "aws_servicequotas_service_quota" "rds_instances" {
  service_code = "rds"
  quota_code   = "L-7B6409FD"
}

data "aws_ec2_instance_type" "capacity" {
  for_each      = toset(concat(var.general_instance_types, var.compute_instance_types, var.ai_runtime_enabled ? ["m6i.large"] : []))
  instance_type = each.key
}

# Extra planned standard-class vCPU use in this account/region, including other
# cells and any larger Karpenter concurrency reserve selected by the operator.
# This is configured input, not a measurement of available quota headroom.
variable "capacity_extra_reserve_vcpus" {
  description = "Additional standard EC2 vCPUs reserved beyond automatic EKS update surge and one maximum Karpenter instance per enabled pool."
  type        = number
  default     = 0
  validation {
    condition     = var.capacity_extra_reserve_vcpus >= 0 && var.capacity_extra_reserve_vcpus == floor(var.capacity_extra_reserve_vcpus)
    error_message = "capacity_extra_reserve_vcpus must be a nonnegative whole number."
  }
}

locals {
  general_capacity_vcpus = var.general_node_max_size * max(concat([0], [for instance in var.general_instance_types : data.aws_ec2_instance_type.capacity[instance].default_vcpus])...)
  compute_capacity_vcpus = var.compute_node_max_size * max(concat([0], [for instance in var.compute_instance_types : data.aws_ec2_instance_type.capacity[instance].default_vcpus])...)
  parser_capacity_vcpus  = var.ai_runtime_enabled ? 2 * data.aws_ec2_instance_type.capacity["m6i.large"].default_vcpus : 0
  managed_capacity_vcpus = local.general_capacity_vcpus + local.compute_capacity_vcpus + local.parser_capacity_vcpus
  # EKS DEFAULT upgrades temporarily add up to 2 nodes per AZ (maxUnavailable=1).
  # Count all groups updating concurrently; preserve availability and sizing.
  managed_update_surge_vcpus = 2 * length(var.availability_zones) * (
    max(concat([0], [for instance in var.general_instance_types : data.aws_ec2_instance_type.capacity[instance].default_vcpus])...) +
    max(concat([0], [for instance in var.compute_instance_types : data.aws_ec2_instance_type.capacity[instance].default_vcpus])...) +
    (var.ai_runtime_enabled ? data.aws_ec2_instance_type.capacity["m6i.large"].default_vcpus : 0)
  )
  # The chart fixes instanceCpus to [2,4]. One largest instance per enabled
  # pool is a replacement/concurrency reserve, not a proof of maximum overrun.
  karpenter_surge_reserve_vcpus = 4 * local.karpenter_enabled_pools
  required_capacity_vcpus       = local.managed_capacity_vcpus + local.managed_update_surge_vcpus + local.karpenter_capacity_vcpus + local.karpenter_surge_reserve_vcpus + var.capacity_extra_reserve_vcpus
  required_rds_instances        = 1 + length(local.postgres_shard_ids) + length(local.postgres_shard_replicas)
}

output "disposable_capacity_requirement" {
  description = "Configured managed maxima, simultaneous DEFAULT update surge, Karpenter limits and reserves versus approved quotas. Does not measure spare capacity or bound eventual-consistency overruns."
  value = {
    managed_maximum_vcpus         = local.managed_capacity_vcpus
    managed_update_surge_vcpus    = local.managed_update_surge_vcpus
    karpenter_limit_vcpus         = local.karpenter_capacity_vcpus
    karpenter_surge_reserve_vcpus = local.karpenter_surge_reserve_vcpus
    extra_reserved_vcpus          = var.capacity_extra_reserve_vcpus
    required_standard_vcpus       = local.required_capacity_vcpus
    approved_standard_vcpus       = data.aws_servicequotas_service_quota.standard_vcpus.value
    required_rds_instances        = local.required_rds_instances
    approved_rds_instances        = data.aws_servicequotas_service_quota.rds_instances.value
  }
  precondition {
    condition     = length(var.general_instance_types) > 0 && length(var.compute_instance_types) > 0
    error_message = "Disposable node pools require explicit nonempty instance type lists."
  }
  precondition {
    condition     = data.aws_servicequotas_service_quota.standard_vcpus.value >= local.required_capacity_vcpus
    error_message = "Approved regional EC2 standard vCPU quota cannot support configured managed maxima, update surge, Karpenter limits and reserves. Obtain sufficient approved quota before apply; do not reduce service requests to fit."
  }
  precondition {
    condition     = data.aws_servicequotas_service_quota.rds_instances.value >= local.required_rds_instances
    error_message = "Approved regional RDS instance quota cannot support the configured central database, four shards and replicas."
  }
}
