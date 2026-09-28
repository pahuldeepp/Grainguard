# Disposable secret setup and rotation

Terraform creates named Secrets Manager containers only. Secret values must
enter `AWSCURRENT` through an approved operator workflow outside Git and
Terraform. The one-shot sync below writes Kubernetes `Opaque` Secrets directly
through `kubectl` stdin; no value is passed in command arguments, chart values,
Terraform state, or this repository. Use an operator identity limited to this
disposable account and cluster. Do not enable shell tracing or retain verbose
CLI logs while handling values.

For a fresh **disposable** environment, five source values can be generated
without operator-supplied credentials: the PostgreSQL role passwords listed in
the bootstrap SQL, Grafana's admin password, and the CDC credential derived
from the current bootstrap `CDC_DB_PASSWORD`, plus OpenSearch admin and
reader/writer passwords. The OpenSearch TLS and CA sources are deliberately
excluded; their keys and service-hostname certificates require a separate
approved provisioning workflow. After Terraform has created
their empty Secrets Manager containers, run the guarded seeder. Its first mode
is read-only and returns 1 while a source version is missing; `--apply` writes
only missing `AWSCURRENT` versions. It checks the AWS account, region, exact
source names and version state before generating anything. It never rotates an
existing value or prints generated values. It rejects an existing CDC source
whose password differs from the current bootstrap role, and rejects a CDC
source present without the bootstrap source. Treat a partial run as retryable.

```sh
python3 infra/gitops/disposable/seed-generated-secrets.py \
  --account-id 123456789012 --region us-east-1 --environment disposable
python3 infra/gitops/disposable/seed-generated-secrets.py --apply \
  --account-id 123456789012 --region us-east-1 --environment disposable
```

This does **not** complete one-command secret provisioning. Every runtime
source still needs its exact service environment contract and connections;
the RDS CA must come from an authenticated AWS trust bundle; MQTT/server TLS
and device credentials need their approved hostname and inventory; external
provider credentials require operator input; and a real Cognito user must be
enrolled with tenant membership. Do not synthesize dummy values to pass the
readiness gate. Integrate the seeder between Terraform secret-container
creation and `sync-secrets.py`, then supply and validate those remaining
sources through an owned workflow before opening the application gate.

Each source name is `greenguard/<environment>/<Kubernetes Secret name>`.
Its `SecretString` must be a JSON object of nonempty string keys and values.
Required names are the non-dashboard `secret` entries in `contract.json`,
plus `greenguard-rds-bootstrap`, `greenguard-rds-ca`, `grafana-admin`,
`greenguard-pgbouncer-auth`, `greenguard-cdc-credentials`,
`greenguard-opensearch-admin`, `greenguard-opensearch-clients`,
`greenguard-opensearch-tls`, and `greenguard-opensearch-ca` (all included in
Terraform `secret_names`). Cassandra additionally requires
`greenguard-cassandra-auth` (`admin-password`, `reader-password`,
`writer-password`) and `greenguard-cassandra-tls` (`server.p12`,
`keystore-password`, `ca.crt`), also included in `secret_names`. The
certificate and PKCS12 keystore must be operator supplied and validated by
the secure Cassandra chart.
Kafka additionally requires `greenguard-kafka-auth` for broker and Registry
server credentials and TLS material, `greenguard-kafka-ca` for client trust
roots, `greenguard-kafka-connect-auth` for Connect client credentials, and
`greenguard-kafka-admin-auth` for the topic bootstrap Job.
The server Secret contains `broker-jaas`, `registry-kafka-jaas`,
`broker.keystore.p12`, `broker.truststore.p12`, `keystore-password`,
`key-password`, `truststore-password`, `registry.keystore.p12`,
`registry-keystore-password`, `registry-key-password`,
`kafka.truststore.p12`, `registry-jaas.conf`, and
`registry-users.properties`. PKCS12 values are base64 strings in AWS JSON;
the sync decodes them to binary Kubernetes Secret keys. The CA Secret contains
exactly `ca.crt` and `registry-ca.crt` PEM certificates. The Connect Secret
contains exactly `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`,
`KAFKA_SASL_JAAS_CONFIG`, `SCHEMA_REGISTRY_USERNAME`, and
`SCHEMA_REGISTRY_PASSWORD`, and `SCHEMA_REGISTRY_BASIC_USER_INFO` equal to
`SCHEMA_REGISTRY_USERNAME:SCHEMA_REGISTRY_PASSWORD`. The admin Secret contains the first three Kafka
keys. The JAAS value in each Secret must exactly match its username and
password in `PlainLoginModule required username="..." password="...";`
form. The topic Job mounts only the admin Secret and CA, writes a private
client properties file, and requires SASL_SSL/PLAIN for create, alter and
describe. The broker
certificate needs both the service DNS SAN
`kafka.greenguard.svc.cluster.local` and the advertised pod DNS SAN
`kafka-0.kafka-headless.greenguard.svc.cluster.local`, and the Registry
certificate needs `schema-registry.greenguard.svc.cluster.local`. The
Registry user must appear in `registry-users.properties` with the
`registry-user` role. Application client credentials belong in their own
runtime Secrets; mount only `greenguard-kafka-ca` into client Pods.
Each non-dashboard runtime Secret must contain `KAFKA_SASL_USERNAME` equal to
its release name and a nonempty `KAFKA_SASL_PASSWORD`. The guarded preflight
requires the broker JAAS to contain the exact matching user/password pair.
`notification-service-config` must also contain the Registry Basic username
and password for its HTTPS contacts projector. Runtime Helm values set
`KAFKA_REQUIRE_TLS=true` and mount the CA-only Secret; missing credentials
therefore stop startup rather than falling back to plaintext.
PgBouncer requires exactly `userlist.txt`; the CDC
source requires exactly `CDC_DB_PASSWORD`, equal to the RDS bootstrap role
password. OpenSearch requires exact admin, reader/writer and TLS keys; its
chart additionally verifies certificate chain, key and service-hostname SAN.
`read-api-config` and `search-indexer-config` must each set
`ELASTICSEARCH_URL=https://greenguard-opensearch.greenguard.svc.cluster.local:9200`.
Their reader/writer usernames and passwords are injected by the scoped Helm
profiles from `greenguard-opensearch-clients`; duplicating those keys in the
runtime environment source is rejected. Cassandra endpoints, TLS parameters
and reader/writer credentials are likewise injected by the secured Read API
and writer profiles, rather than duplicated in runtime environment sources.
Runtime objects contain each service's approved
environment variables. The sync can prove that keys are populated and match
AWS; each service owner must still approve its exact variable contract.

The `greenguard-rds-bootstrap` AWS value contains **exactly** the role password
keys named by `\getenv` in `rds-bootstrap-chart/files/init-databases.sql`.
Do not put `PGHOST` or `PGPASSWORD` there. During sync, those two keys are read
from the selected RDS instance endpoint and its RDS-managed `AWSCURRENT`
master secret and added only to the Kubernetes target. This avoids a second
stored copy of the master password in Secrets Manager. The CA source contains
only `ca.pem`, with the approved AWS RDS trust bundle in PEM form. The Grafana
source contains exactly `GF_SECURITY_ADMIN_USER` and
`GF_SECURITY_ADMIN_PASSWORD`; it must be populated before the observability
Application can become healthy.

Run from the repository root after creating and populating every source and
configuring `kubectl` for the target cluster. The command checks the exact AWS
account and EKS API endpoint before reading or writing any Kubernetes Secret.
It reads every source before attempting a write, refuses to replace an
unowned or differently sourced target, and carries Kubernetes resourceVersion
on replacement so concurrent edits cannot be overwritten silently.

```sh
python3 infra/gitops/disposable/sync-secrets.py \
  --account-id 123456789012 --region ca-central-1 \
  --environment disposable --cluster greenguard-disposable \
  --rds-instance gg-greenguard-disposable-example-postgres

python3 infra/gitops/disposable/sync-secrets.py --apply \
  --account-id 123456789012 --region ca-central-1 \
  --environment disposable --cluster greenguard-disposable \
  --rds-instance gg-greenguard-disposable-example-postgres
```

The first command is a read-only plan and exits nonzero if changes are needed.
`--apply` creates or replaces only changed Secrets, then runs the readiness
comparison. Both commands withhold values from their output. A partial failure
is safe to rerun: unchanged, matching targets are skipped. If an older Secret
was created by a different owner, resolve that ownership deliberately before
sync; the script will not take it over.

After an application-side credential rotation, promote the new source version
to `AWSCURRENT`, rerun the plan and `--apply`, then restart or roll the pods
whose environment variables use that Secret. Environment variables do not
refresh in a running process. On RDS master rotation, rerun sync so the
derived `PGPASSWORD` and master-version annotation update. Run the readiness
check immediately before enabling the application tree and after each
rotation:

```sh
python3 infra/gitops/disposable/check-secrets-ready.py \
  --account-id 123456789012 --region ca-central-1 \
  --environment disposable --cluster greenguard-disposable \
  --rds-instance gg-greenguard-disposable-example-postgres
```

The readiness check compares every Kubernetes key/value to AWS `AWSCURRENT`
and checks source/master version annotations. It is a point-in-time gate, not
continuous reconciliation. Rotation and pod restart remain operator actions.
