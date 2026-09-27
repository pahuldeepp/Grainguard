# Disposable AWS data layer: ownership and open gates

`data-storage.tf` adds a private PostgreSQL 16 RDS instance with an RDS-managed
master password, a one-day automated backup window, bounded storage growth,
logical decoding parameters, and a private audit-export S3 bucket. The bucket
blocks public access, enforces TLS, encrypts objects at rest, and empties on
destroy. The database skips the final snapshot and deletes its automated
backups on destroy because this cell is disposable. None of these settings is
appropriate as an unchanged production data policy.

The instance is **not** an initialized GreenGuard database. The following
sequence remains a hard deployment gate:

1. Wait for RDS availability and verify TLS connectivity from an EKS migration
   job through the allowed security-group path.
2. Obtain the RDS-managed master secret through a narrowly scoped IAM role.
   Generate separate application, migrator, and CDC passwords in Secrets
   Manager; never put passwords in Terraform variables, outputs, job arguments,
   or logs.
3. Adapt `infra/compose/init-databases.sql` to RDS privileges. Its local
   `ALTER ROLE cdc_reader LOGIN REPLICATION` is not a drop-in RDS operation;
   use the RDS replication role and verify Debezium's permissions in an RDS
   integration test. Then create all eleven owner databases, runtime roles,
   migrator roles, and CDC grants before application deployment.
4. Run every owner migration in a versioned, idempotent Kubernetes Job with
   the owner credential, and verify each tenant table's forced RLS policy.
5. Start PgBouncer with TLS to RDS and transaction pooling. Services must use
   their own RLS-limited runtime credential; direct owner URLs are reserved
   for migrations. Prove `set_config(..., true)` tenant scoping on RDS.
6. Register logical publications and Debezium connectors only after schemas
   exist. Monitor inactive slots and retained WAL against the configured
   2 GiB per-slot limit.

Other required data systems are still unowned by this Terraform root:

| System | Existing local shape | AWS deployment gap |
| --- | --- | --- |
| Kafka, Connect, schema registry | `infra/kafka/compose.yaml`, pinned connector JSON | No broker, controller, topic, connector, or schema lifecycle |
| RabbitMQ | Local Compose broker | No AWS/EKS deployment, credential, queue policy, or health gate |
| Redis | Local Compose cache | No AWS/EKS deployment, credential, persistence, or topology contract |
| Cassandra | `infra/cassandra/compose.yaml` | No keyspace/schema migration or AWS/EKS deployment |
| OpenSearch | `infra/search/` | No index/template migration or AWS/EKS deployment |
| MQTT | `infra/mqtt/mosquitto.conf` | No durable broker/session deployment or device network endpoint |
| PgBouncer | `infra/compose/pgbouncer/pgbouncer.ini` | No RDS-aware config, TLS, secret sync, or EKS workload |

Do not remove the disposable root's readiness gate or run an AWS apply based
on these foundation resources alone. A successful `terraform validate` proves
HCL shape, not service readiness, RDS compatibility, migrations, or teardown.
