# RDS bootstrap contract

The Argo Application at wave 20 runs a bounded PostgreSQL 16 `psql` Job. The
SQL is copied exactly from `infra/compose/init-databases.sql` and
`ruby infra/gitops/disposable/check-rds-bootstrap.rb` rejects copy drift.
The Job uses `GG_RDS=1` to grant the RDS-specific `rds_replication` role.
It creates roles and databases only; it does **not** apply owner schema
migrations.

Operational shard Applications also render a second, ordered login-provisioning
Job after the database bootstrap succeeds. It reads only `PGPASSWORD` from the
shard admin Secret and `TENANT_BOOTSTRAP_PASSWORD` from that shard's separate
`greenguard-sN-tenant-bootstrap` Secret. It creates/rotates
`tenant_bootstrap_sN` as a NOINHERIT, nonprivileged LOGIN, grants SET ROLE
membership in `tenant_ownership_bootstrap`, and grants CONNECT only to the
nine operational owner databases. PostgreSQL's default PUBLIC CONNECT on
`postgres` and `template1` is revoked (with admin access restored on `postgres`).
The Job name includes the Secrets Manager version ID, so a password version
change makes Argo create a new provisioning Job. Central bootstrap does not
render this per-shard login Job.

Before this Job can start, a secret synchronization controller or an
equivalent Terraform-owned bootstrap must create `greenguard-rds-bootstrap`
in namespace `greenguard` with `PGHOST`, `PGPASSWORD`, and every environment
key named by a `\\getenv` line in the SQL source. `PGHOST` must be the RDS
DNS name, not an IP address, because the Job uses `PGSSLMODE=verify-full`.
`greenguard-rds-ca` must contain `ca.pem` with the appropriate AWS RDS trust
bundle. The Job never embeds passwords in chart values, command arguments,
or Terraform state. Missing Secrets leave the Job unschedulable and the Argo
Application unhealthy.

The tenant bootstrap worker receives four read-only projected `registry.json`
files and a separate read-only CA mount. Each file contains exactly the nine
owner database connections for one shard. The `TENANT_BOOTSTRAP_PASSWORD` key
in each shard Secret is not projected into the worker Pod.

The [disposable secret sync](../SECRETS.md) reads role passwords from a
separate operator-populated Secrets Manager value and derives `PGHOST` and
`PGPASSWORD` from the selected RDS instance and its managed master secret.
It materializes the Kubernetes Secret out of band, without Terraform state.
This remains a fail-closed deployment design until the operator runs sync and
the live Job proves role grants and logical decoding on RDS.

## Optional managed Dex storage

The disposable OIDC path may set `managedDex: true` on the central bootstrap
Application. In that mode the SQL bootstrap requires `DEX_DB_PASSWORD`, creates
only the tagged `dex_app` role and `greenguard_dex` database, refuses to adopt
objects without the GreenGuard ownership comments, and gives the database owner
only to that non-superuser Dex role. Operational shard bootstrap leaves the Dex
branch disabled. With the default external-OIDC mode, the password input and
Dex objects are not required.
