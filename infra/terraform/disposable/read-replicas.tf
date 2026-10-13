variable "postgres_read_replica_count" {
  description = "Private read replicas per operational shard, each billed separately. Initial default is exactly one per shard."
  type        = number
  default     = 1
  validation {
    condition     = var.postgres_read_replica_count >= 0 && var.postgres_read_replica_count <= 5 && floor(var.postgres_read_replica_count) == var.postgres_read_replica_count
    error_message = "postgres_read_replica_count must be an integer from 0 through 5."
  }
}

locals {
  postgres_shard_ids = toset(["s1", "s2", "s3", "s4"])
  postgres_shard_replicas = merge([for shard_id in local.postgres_shard_ids : {
    for replica in range(var.postgres_read_replica_count) : "${shard_id}-r${replica + 1}" => {
      shard_id = shard_id
      ordinal  = replica + 1
    }
  }]...)
}

resource "aws_db_instance" "shard" {
  depends_on                  = [terraform_data.destroy_inventory_sentinel]
  for_each                    = local.postgres_shard_ids
  identifier                  = "gg-${substr(local.data_name_prefix, 0, 36)}-${local.data_name_hash}-shard-${each.key}"
  engine                      = "postgres"
  engine_version              = "16"
  instance_class              = var.postgres_instance_class
  allocated_storage           = 20
  max_allocated_storage       = 100
  storage_type                = "gp3"
  storage_encrypted           = true
  db_subnet_group_name        = aws_db_subnet_group.postgres.name
  vpc_security_group_ids      = [aws_security_group.postgres.id]
  parameter_group_name        = aws_db_parameter_group.postgres.name
  publicly_accessible         = false
  multi_az                    = false
  username                    = "greenguard_admin"
  manage_master_user_password = true
  backup_retention_period     = 1
  copy_tags_to_snapshot       = true
  skip_final_snapshot         = true
  delete_automated_backups    = true
  deletion_protection         = false
  apply_immediately           = true
  auto_minor_version_upgrade  = true
  tags = {
    Name    = "${var.cluster_name}-shard-${each.key}"
    Cell    = var.cluster_name
    ShardId = each.key
    Role    = "shard-primary"
  }
}

resource "aws_db_instance" "read_replica" {
  depends_on             = [terraform_data.destroy_inventory_sentinel]
  for_each               = local.postgres_shard_replicas
  identifier             = "${aws_db_instance.shard[each.value.shard_id].identifier}-r${each.value.ordinal}"
  replicate_source_db    = aws_db_instance.shard[each.value.shard_id].identifier
  instance_class         = var.postgres_instance_class
  vpc_security_group_ids = [aws_security_group.postgres.id]
  parameter_group_name   = aws_db_parameter_group.postgres.name
  publicly_accessible    = false
  storage_encrypted      = true
  # Omit StorageType: CreateDBInstanceReadReplica requires Iops when StorageType
  # is explicitly gp3. The source's gp3/default storage is inherited here.
  max_allocated_storage      = aws_db_instance.shard[each.value.shard_id].max_allocated_storage
  backup_retention_period    = 0
  copy_tags_to_snapshot      = true
  skip_final_snapshot        = true
  delete_automated_backups   = true
  deletion_protection        = false
  apply_immediately          = true
  auto_minor_version_upgrade = true
  tags = {
    Name    = "${var.cluster_name}-${each.key}"
    Cell    = var.cluster_name
    ShardId = each.value.shard_id
    Role    = "read-replica"
  }
}

# Secret containers only. Values are generated/synced out of band; Terraform
# owns deletion without placing runtime passwords in its state.
resource "aws_secretsmanager_secret" "shard" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each = toset(flatten([for shard_id in local.postgres_shard_ids : [
    "${shard_id}/bootstrap", "${shard_id}/migrators",
    "${shard_id}/pgbouncer", "${shard_id}/cdc", "${shard_id}/tenant-bootstrap"
  ]]))
  name                    = "greenguard/${var.environment}/shards/${each.key}"
  recovery_window_in_days = 0
  tags                    = { Cell = var.cluster_name, ShardId = split("/", each.key)[0] }
}

output "postgres_shards" {
  description = "Private shard registry by stable shard ID. Contains endpoints and secret ARNs, never credentials."
  value = { for shard_id, shard in aws_db_instance.shard : shard_id => {
    primary_host         = shard.address
    primary_port         = shard.port
    replica_hosts        = [for replica_id, replica in aws_db_instance.read_replica : replica.address if local.postgres_shard_replicas[replica_id].shard_id == shard_id]
    master_secret_arn    = shard.master_user_secret[0].secret_arn
    bootstrap_secret_arn = aws_secretsmanager_secret.shard["${shard_id}/bootstrap"].arn
    migrators_secret_arn = aws_secretsmanager_secret.shard["${shard_id}/migrators"].arn
    pgbouncer_secret_arn = aws_secretsmanager_secret.shard["${shard_id}/pgbouncer"].arn
    cdc_secret_arn       = aws_secretsmanager_secret.shard["${shard_id}/cdc"].arn
  } }
}

output "postgres_read_replica_endpoints" {
  description = "Replicas grouped by owning shard. Never combine these into a global round-robin pool."
  value = { for shard_id in local.postgres_shard_ids : shard_id => [
    for replica_id, replica in aws_db_instance.read_replica : replica.endpoint
    if local.postgres_shard_replicas[replica_id].shard_id == shard_id
  ] }
}

resource "aws_secretsmanager_secret" "shard_routing" {
  depends_on = [terraform_data.destroy_inventory_sentinel]
  for_each = toset([
    "device-service", "telemetry-ingest", "projection-builder", "risk-engine",
    "workflow-alerts", "jobs-worker", "notification-service", "saga-orchestrator",
    "hardware-service", "read-api", "audit-export-worker"
  ])
  name                    = "greenguard/${var.environment}/shard-routing/${each.key}"
  recovery_window_in_days = 0
  tags                    = { Cell = var.cluster_name, Service = each.key }
}

output "shard_routing_secret_arns" {
  description = "One least-privilege routing Secret container per database-owning service, to materialize SHARD_DATABASES_FILE without credential values in state."
  value       = { for service, secret in aws_secretsmanager_secret.shard_routing : service => secret.arn }
}
