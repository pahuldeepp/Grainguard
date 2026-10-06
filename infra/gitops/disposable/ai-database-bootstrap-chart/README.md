# AI database bootstrap

This chart provisions isolated PostgreSQL databases and roles for Knowledge,
Grain Advisor, the optional Advisor checkpoint store, and Model Gateway usage.
It is disabled by default and is not yet wired into the root Argo application or
Terraform runtime Secret synchronization. Its separate AI schema-migration
acceptance gate does not alter the existing 11-owner core migration gate.

The job requires two existing Kubernetes Secrets:

* `adminSecret`: the central RDS bootstrap projection containing `PGPASSWORD`
  for `greenguard_admin`. It is used only by this one-shot role/database job.
* `roleSecret`: exactly the twelve password keys listed in the SQL file. The
  job never logs variable values.

The CA Secret must contain `ca.pem`; the RDS hostname and private CIDRs must
refer to the disposable central RDS. Egress is limited to DNS and TCP/5432 to
the supplied RDS CIDRs. RDS TLS uses `verify-full`.

Databases: `greenguard_knowledge`, `greenguard_advisor`,
`greenguard_advisor_checkpoint`, and `greenguard_ai_usage`. Runtime roles are
non-superuser, `NOBYPASSRLS`, and are separate from schema-owner/migration
roles. The checkpoint database and role are provisioned separately because
LangGraph checkpoint tables are not tenant-RLS protected by the current saver.
Knowledge HTTP API and background workers use separate `knowledge_app` and
`knowledge_worker` logins; the worker role receives only the explicit consumer
table/function grants in migration `000019_worker_database_role` and remains
subject to forced tenant (and, for retention/summary, user) RLS.

## Deployment limits

This chart creates database/role ownership only. Guarded RDS migration runners
are included in the Knowledge and Advisor service images as `migrate_rds.py`,
and in the Model Gateway image as `/model-gateway-migrate`. They require a 0600
DSN file, exact RDS host, fixed database and migration owner, and PostgreSQL
`verify-full` with the projected RDS CA. The local fixture script applies these
migrations as their owner roles and checks replay/idempotency plus selected
RLS/role properties. The runners are not yet wired as Argo Jobs. A separate
checkpoint-schema migration job is still pending, so checkpoint-backed
workflows remain disabled.

Advisor's optional LangGraph deployment path still has planner and MCP adapters
that deliberately fail closed; do not enable that workflow or advertise it as a
working AI assistant. Before enabling the runtime, add immutable image
references, migration Jobs for every database owner, provider/IdP/Kafka/S3/
Pinecone credentials, IAM access for the dedicated Knowledge source bucket, a
secret synchronization owner, and a gate that requires AI migrations and real
dependency readiness. No AWS deployment was run here.

Run `infra/gitops/disposable/test-ai-database-migrations-local.sh` for the
portless local PostgreSQL fixture. It executes the bootstrap twice, applies all
Knowledge, Advisor, and Model Gateway SQL migrations as their non-superuser
migrator roles, replays via migration ledgers, and fails if tenant-owned tables
do not have forced RLS or selected roles bypass RLS. This is offline PostgreSQL
16 fixture evidence; it does not validate RDS/IAM/Argo integration or the
optional checkpoint database schema.
