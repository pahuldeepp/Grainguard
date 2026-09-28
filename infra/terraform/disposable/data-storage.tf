# Disposable data foundation. Application databases, roles, RLS migrations,
# Debezium slots and connector registration must run as explicit deployment
# jobs after this instance is available; an RDS instance alone is not a
# functioning GreenGuard data plane.
locals {
  data_name_prefix = lower(replace(var.cluster_name, "_", "-"))
  data_name_hash   = substr(sha256(var.cluster_name), 0, 8)
  postgres_name    = "gg-${substr(local.data_name_prefix, 0, 42)}-${local.data_name_hash}-postgres"
  audit_bucket     = "${substr(local.data_name_prefix, 0, max(1, 34 - length(var.aws_region)))}-${local.data_name_hash}-${var.target_account_id}-${var.aws_region}-audit"
}

resource "aws_db_subnet_group" "postgres" {
  name       = local.postgres_name
  subnet_ids = [for zone in local.az_names : aws_subnet.private[zone].id]
  tags       = { Name = "${var.cluster_name}-postgres" }
}

resource "aws_security_group" "postgres" {
  name_prefix = "${local.postgres_name}-"
  description = "GreenGuard disposable PostgreSQL from EKS workloads"
  vpc_id      = aws_vpc.cell.id

  ingress {
    description     = "PostgreSQL from EKS cluster security group"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_eks_cluster.cell.vpc_config[0].cluster_security_group_id]
  }

  # Security groups are stateful. RDS only needs to answer established
  # connections, so no outbound rule is granted.
  egress = []

  tags = { Name = "${var.cluster_name}-postgres" }
}

resource "aws_db_parameter_group" "postgres" {
  name_prefix = "${local.postgres_name}-"
  family      = "postgres16"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  # Debezium PostgreSQL connectors need logical decoding. The slot budget
  # must be revisited when the connector inventory changes.
  parameter {
    name         = "rds.logical_replication"
    value        = "1"
    apply_method = "pending-reboot"
  }
  parameter {
    name         = "max_replication_slots"
    value        = "20"
    apply_method = "pending-reboot"
  }
  parameter {
    name         = "max_wal_senders"
    value        = "20"
    apply_method = "pending-reboot"
  }
  parameter {
    name         = "max_slot_wal_keep_size"
    value        = "2048"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "postgres" {
  identifier                  = local.postgres_name
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

  lifecycle {
    precondition {
      condition     = can(regex("^[a-z][a-z0-9-]*[a-z0-9]$", local.postgres_name))
      error_message = "The normalized RDS identifier must start with a letter and end with a letter or digit."
    }
  }

  tags = { Name = "${var.cluster_name}-postgres" }
}

variable "postgres_instance_class" {
  description = "Disposable PostgreSQL instance class. Size must be reviewed against CDC and migration load."
  type        = string
  default     = "db.t4g.medium"
  validation {
    condition     = can(regex("^db\\.[a-z0-9]+\\.[a-z0-9]+$", var.postgres_instance_class))
    error_message = "postgres_instance_class must be a valid-looking RDS instance class."
  }
}

output "postgres_endpoint" {
  description = "Private RDS endpoint. The admin credential is not emitted."
  value       = aws_db_instance.postgres.address
}

output "postgres_master_secret_arn" {
  description = "RDS-managed master secret ARN for a tightly scoped migration bootstrap role."
  value       = aws_db_instance.postgres.master_user_secret[0].secret_arn
}

# A private audit-export bucket is the first S3 object-store use case. The
# object data is intentionally disposable; force_destroy is limited to this
# dedicated environment- and account-qualified bucket.
resource "aws_s3_bucket" "audit_exports" {
  bucket        = local.audit_bucket
  force_destroy = true
  tags = {
    Name        = "${var.cluster_name}-audit-exports"
    Environment = var.environment
    Lifecycle   = "Disposable"
    Cell        = var.cluster_name
    ManagedBy   = "Terraform"
  }

  lifecycle {
    precondition {
      condition     = length(local.audit_bucket) <= 63 && can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", local.audit_bucket))
      error_message = "The account-qualified audit bucket name must be a valid S3 bucket name of at most 63 characters."
    }
  }
}

resource "aws_s3_bucket_public_access_block" "audit_exports" {
  bucket                  = aws_s3_bucket.audit_exports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "audit_exports" {
  bucket = aws_s3_bucket.audit_exports.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit_exports" {
  bucket = aws_s3_bucket.audit_exports.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    bucket_key_enabled = false
  }
}

resource "aws_s3_bucket_policy" "audit_exports" {
  bucket = aws_s3_bucket.audit_exports.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.audit_exports.arn, "${aws_s3_bucket.audit_exports.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.audit_exports]
}

output "audit_export_bucket" {
  value = aws_s3_bucket.audit_exports.id
}
