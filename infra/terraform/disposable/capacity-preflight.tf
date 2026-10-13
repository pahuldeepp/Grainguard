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

locals {
  general_capacity_vcpus  = var.general_node_max_size * max(concat([0], [for instance in var.general_instance_types : data.aws_ec2_instance_type.capacity[instance].default_vcpus])...)
  compute_capacity_vcpus  = var.compute_node_max_size * max(concat([0], [for instance in var.compute_instance_types : data.aws_ec2_instance_type.capacity[instance].default_vcpus])...)
  parser_capacity_vcpus   = var.ai_runtime_enabled ? 2 * data.aws_ec2_instance_type.capacity["m6i.large"].default_vcpus : 0
  required_capacity_vcpus = local.general_capacity_vcpus + local.compute_capacity_vcpus + local.parser_capacity_vcpus
  required_rds_instances  = 1 + length(local.postgres_shard_ids) + length(local.postgres_shard_replicas)
}

output "disposable_capacity_requirement" {
  description = "Configured node/database maxima versus approved regional quotas; does not prove available spare capacity."
  value = {
    required_standard_vcpus = local.required_capacity_vcpus
    approved_standard_vcpus = data.aws_servicequotas_service_quota.standard_vcpus.value
    required_rds_instances  = local.required_rds_instances
    approved_rds_instances  = data.aws_servicequotas_service_quota.rds_instances.value
  }
  precondition {
    condition     = length(var.general_instance_types) > 0 && length(var.compute_instance_types) > 0
    error_message = "Disposable node pools require explicit nonempty instance type lists."
  }
  precondition {
    condition     = data.aws_servicequotas_service_quota.standard_vcpus.value >= local.required_capacity_vcpus
    error_message = "Approved regional EC2 standard vCPU quota cannot support the configured node-pool maxima. Request the quota increase before apply."
  }
  precondition {
    condition     = data.aws_servicequotas_service_quota.rds_instances.value >= local.required_rds_instances
    error_message = "Approved regional RDS instance quota cannot support the configured central database, four shards and replicas."
  }
}
