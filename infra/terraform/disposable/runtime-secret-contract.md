# Disposable runtime Secret ownership

`runtime_secret_values` is a sensitive map of approved Kubernetes Secret names to
nonempty string maps. Supply real upstream credentials and valid TLS/CA material.
`secret_names` approves the AWS containers. Values enter Terraform state: use an
approved encrypted backend and protect plans/state as credentials.

Terraform derives the two central runtime database URLs and 38 migration URLs
from actual RDS addresses and bootstrap role passwords. The migration inventory
is read from `_owner-migrations.tpl`; roles, database names, keys and TLS settings
are fixed. Operational services do not receive central database fallback URLs.

`shard_role_passwords` supplies exactly s1-s4, each with the full role key set in
the bootstrap SQL. `shard_registry_passwords` supplies exactly these ten service
keys, each containing exactly s1-s4 passwords matching its bootstrap role:

| Service | Database | Role |
| --- | --- | --- |
| device-service | greenguard_inventory | inventory_app |
| telemetry-ingest | greenguard_telemetry | telemetry_app |
| projection-builder | greenguard_read | projection_app |
| risk-engine | greenguard_risk | risk_app |
| workflow-alerts | greenguard_alerts | alerts_app |
| jobs-worker | greenguard_jobs | jobs_app |
| notification-service | greenguard_notifications | notifications_app |
| saga-orchestrator | greenguard_sagas | saga_app |
| hardware-service | greenguard_hardware | hardware_app |
| read-api | greenguard_read | read_query |

The routing sources remain `greenguard/<environment>/shard-routing/<service>`.
Their Kubernetes names are `greenguard-shard-routing-<service>` and their only
key is `registry.json`. JSON matches the production owner registry contract:
`formatVersion`, `service`, `database`, and exactly s1-s4 entries containing
`incarnation`, `primaryUrl`, `replicaUrls`. Each incarnation is UUIDv5 of the
immutable RDS `resource_id` scoped to account/region; physical replacement changes
it. The pinned [AWS provider 6.60.0 source](https://github.com/hashicorp/terraform-provider-aws/blob/v6.60.0/internal/service/rds/instance.go#L42-L51) identifies resource_id as immutable and identifier as mutable. The cached provider schema also confirms resource_id is a computed string. Writers always use the primary URL. Every URL uses verify-full and the mounted
`/etc/greenguard/rds/ca.pem`. Migration jobs use `/rds-ca/ca.pem`.

Integration exports `local.shard_registry_secret_versions` and
`local.shard_registry_secret_sources`, keyed by Kubernetes Secret name. The
lifecycle scope includes explicit nested AWS source names, source version IDs,
four shard bootstrap descriptors, and central/shard master version IDs. RDS
master rotation changes the Terraform synchronization trigger. OIDC identifiers
remain in the selected provider's public chart configuration; this module neither
creates upstream users nor changes the identity provider.

The application namespace precedes `terraform_data.runtime_secret_sync`; GitOps
bootstrap depends on it. Its create provisioner validates all source/resource
ownership, profile equality and cryptographic parsing before Secret writes.
Retries update only the remaining changed objects. A failed partial create is
not rolled back by deleting working Secrets. Destroy preflights the full subset,
then deletes only matching owned versions using UID/resourceVersion conditions.
Changed or foreign objects fail closed. Applications disappear before sync;
namespace, cluster access and nodes remain until cleanup completes. Kubeconfig
exists only in a mode-0600 temporary directory and is removed on completion,
exceptions and handled termination. No global Kubernetes context is changed.

Offline tests exercise valid/rejected scopes, nested source IDs, role/TLS checks,
registry physical endpoint ordering, retry subsets and guarded teardown. They do
not prove AWS/EKS execution, automatic tenant placement bootstrap, live rotation
or teardown. New operational shards remain empty until an authorized placement
workflow seeds ownership; this module never fabricates active ownership.

Shard PgBouncer and CDC versions derive from the same approved shard role input.
PgBouncer includes exactly nine runtime owners, read_query and three projector
roles; migrators remain direct to RDS. Its quoted userlist rejects passwords with
quotes, backslashes or line breaks before apply. CDC equals the bootstrap CDC
password. Neither value needs an out-of-band copy.

Cleanup is recorded separately in `terraform_data.runtime_secret_cleanup`, which
has no create provisioner. The sync resource depends on this ownership record.
A failed create provisioner can taint sync, but cannot taint cleanup; Terraform
otherwise skips destroy provisioners on tainted resources. This preserves the
record needed to remove a successfully written subset after a failed apply.

Apply/destroy must run from an approved runner that can reach the private EKS API
and has Python 3, AWS CLI, kubectl and OpenSSL. Offline Terraform validation uses
cached providers; it does not execute these provisioners or contact AWS.
