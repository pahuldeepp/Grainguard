# RDS bootstrap contract

The Argo Application at wave 20 runs a bounded PostgreSQL 16 `psql` Job. The
SQL is copied exactly from `infra/compose/init-databases.sql` and
`ruby infra/gitops/disposable/check-rds-bootstrap.rb` rejects copy drift.
The Job uses `GG_RDS=1` to grant the RDS-specific `rds_replication` role.
It creates roles and databases only; it does **not** apply owner schema
migrations.

Before this Job can start, a secret synchronization controller or an
equivalent Terraform-owned bootstrap must create `greenguard-rds-bootstrap`
in namespace `greenguard` with `PGHOST`, `PGPASSWORD`, and every environment
key named by a `\\getenv` line in the SQL source. `PGHOST` must be the RDS
DNS name, not an IP address, because the Job uses `PGSSLMODE=verify-full`.
`greenguard-rds-ca` must contain `ca.pem` with the appropriate AWS RDS trust
bundle. The Job never embeds passwords in chart values, command arguments,
or Terraform state. Missing Secrets leave the Job unschedulable and the Argo
Application unhealthy.

The [disposable secret sync](../SECRETS.md) reads role passwords from a
separate operator-populated Secrets Manager value and derives `PGHOST` and
`PGPASSWORD` from the selected RDS instance and its managed master secret.
It materializes the Kubernetes Secret out of band, without Terraform state.
This remains a fail-closed deployment design until the operator runs sync and
the live Job proves role grants and logical decoding on RDS.
