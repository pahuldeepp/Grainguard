# Disposable PgBouncer and streaming bootstrap

These standalone Helm charts are offline implementation slices. PgBouncer,
Kafka topics, Connect, connector registration, OpenSearch, Cassandra and private MQTT have conditional child Applications in
the disposable Argo tree. `terraform apply` still has a closed readiness gate. Run
`ruby infra/gitops/disposable/check-data-plane.rb` for shape and inventory
checks; `--ready` deliberately fails with the missing prerequisites.

## Required order

1. The wave-10 data Application brings up Kafka without Schema Registry.
   The wave-12 `streaming-topics-chart` Jobs apply ACLs and create and verify the 45 exact
   topics from `scripts/kafka-topics.mjs`, including `_schemas`, Connect's
   internal topics, Debezium heartbeat topics, and the two ten-minute-retention
   `greenguard.acceptance.*` topics used only by the live Kafka acceptance Job
   (`greenguard.acceptance.denied.v1` intentionally has no ACL). The chart's copy is
   generated with `streaming-topics-chart/generate-topics.rb`; the checker
   rejects drift. It uses the same pinned Kafka image as the broker and
   authenticates with `greenguard-kafka-admin-auth` over SASL_SSL/PLAIN,
   trusting only `greenguard-kafka-ca`. A companion Job applies the reviewed
   `streaming-topics-chart/files/acls.tsv` inventory through the same secured
   admin channel before runtime clients start. Kafka starts with
   `StandardAuthorizer` and `allow.everyone.if.no.acl.found=false`; the
   broker and bootstrap admin identities are the only superusers. Runtime
   clients use their release names as principals and receive topic/group
   permissions scoped to their implemented paths. Schema Registry is a
   separate wave-13 Application, after the ACL and `_schemas` topic Jobs
   finish. It is absent when the data plane is disabled.
2. RDS role/database bootstrap must succeed before PgBouncer. The global
   wave-25 migration gate remains closed until **all** owner schema migrations
   and data initialization are proved.
3. Publish the repository's `infra/compose/pgbouncer/Dockerfile` and
   `infra/kafka/Dockerfile.connect` images to the disposable cell's ECR and
   provide exact OCI digests. The PgBouncer chart also requires the RDS DNS
   name as `rdsHost`; no password belongs in that value. PgBouncer loads
   `userlist.txt` from `greenguard-pgbouncer-auth` and the RDS CA bundle from
   `greenguard-rds-ca`. Its generated config fixes transaction pooling and
   `verify-full` TLS to RDS. Connect loads `CDC_DB_PASSWORD` from
   `greenguard-cdc-credentials`, authenticates to Kafka over SASL_SSL/PLAIN,
   trusts only the Kafka CA and keeps topic auto-creation disabled.
4. The wave-24 registration Job takes an immutable Python image and the RDS
   hostname, adds `verify-full` PostgreSQL TLS, and registers all eight
   checked-in connectors idempotently. It waits for every task to reach
   RUNNING. The contacts Avro converter uses Registry HTTPS with Basic auth
   and a pinned CA. This has offline shape tests only; publications, subject
   registration and source-to-topic flow still need live proof.
5. The conditional child order is topics/ACLs wave 12, Schema Registry wave 13, PgBouncer wave 22,
   Connect wave 23, connector registration wave 24, and OpenSearch/Cassandra wave 24. The search child needs an
   `opensearch_image_digest`, the promoted `search-indexer` digest and four
   exact TLS/admin/client Secret sources before its security and mapping Jobs
   can run. Cassandra needs a pinned server digest, promoted writer/migrator
   digest and exact auth/TLS Secrets; its secure role/schema bootstrap has
   local Docker evidence but EKS recovery and access gating need proof.
   Terraform derives the activator's single API Service `/32` from the
   EKS Service CIDR; compare it with `default/kubernetes` ClusterIP before
   activation in a live cluster. The CNI's Service NAT path also needs proof.
   The private MQTT broker is an Argo wave-11 child with a digest-pinned image, PVC, TLS/ACL Secret, and worker-only NetworkPolicy. Device access remains disabled until a controlled DNS name, device inventory, broker credentials, and live TLS/ACL tests are supplied.
   Prove Argo child health/order, mesh mTLS, egress policy,
   tenant data isolation, and a live BFF→Kafka→read/alert journey in EKS.

The single broker, Schema Registry, Connect worker, and PgBouncer replica are
disposable capacity, not availability proof. The broker requires SASL/PLAIN
over TLS with default-deny ACLs, but live EKS client verification remains open
before the full deployment readiness gate may open.

The PgBouncer, topic and Connect charts produce namespaced Services,
Deployments or Jobs. They create
no cloud resources directly; EKS/CSI/ALB resources remain owned by the
existing Terraform and pre-destroy sequence. Once attached to Argo, each
Application must carry the cell label and resources finalizer so
`pre-destroy.sh` prunes it before EKS. No persistent claim is added here.

## In-cluster data acceptance

The mandatory wave-29 `greenguard-live-acceptance-probes` Application follows
all data bootstrap/schema/ACL Jobs and the wave-28 ClickHouse Application.
It requires enabled Kafka/Redis, Cassandra, OpenSearch and ClickHouse children;
missing or mutable image inputs fail rendering. Data acceptance runs in every
identity mode. The separate membership readback remains enabled only after a
real, verified operator login. Argo child health is necessary, and each probe
also waits for its authenticated data operation to become available before a
bounded Job deadline. The deployment gate requires every data Application and
exactly one successful Job per probe at the release revision and exact owned
image. Completed Jobs remain available for Argo health and evidence; changing
scripts changes their names, and Argo prunes the earlier Job/ConfigMap.

| Probe | Owned image and credential | Disposable fixture and cleanup |
| --- | --- | --- |
| Kafka | `data_plane_image_digests.kafka-topics`; projected `greenguard-kafka-auth/acceptance-client-jaas`, Kafka CA | One UUID key/value on `greenguard.acceptance.probe.v1`; exact consume and denied write/read ACL checks; ten-minute topic retention cleans records. Fixed exact consumer group; no cluster or domain topic grants. |
| Redis | `data_plane_image_digests.redis`; existing `greenguard-data-credentials/REDIS_PASSWORD` | Two UUID tenant hash-tag keys; AUTH denial, exact GET, bounded TTL, DEL and EXISTS checks; 120-second expiry backs failure cleanup. |
| Cassandra | `cassandra_image_digest`; projected writer/reader passwords and CA only | `greenguard_acceptance.probe` has a tenant partition key and 120-second default TTL. Writer inserts two tenant markers; reader verifies partition separation and its write denial; DELETE/readback proves cleanup. The existing grants Job creates only this fixture table and table-scoped permissions. The NetworkPolicy retains the auth-ready activation label. |
| OpenSearch | Python from `cassandra_image_digest`; projected dedicated acceptance reader/writer passwords and CA only | Exact `greenguard-acceptance-probe-v1` index with keyword tenant/marker mapping; UUID documents, filtered search, reader-write and out-of-scope index denial; DELETE and 404 readback. Security bootstrap creates the empty fixture index. No domain-index or cluster permission is added to these identities. |
| ClickHouse | `clickhouse_image_digest`; existing telemetry ClickHouse credentials | One native TCP session on private port 9000 holds a temporary Memory table with two tenant markers; native throwIf insert/select/filter and DROP assertions; disconnect automatically releases temporary data. No domain table is changed. |

Kafka uses SASL_SSL with endpoint identification; Cassandra verifies its native
CQL CA and service DNS on every actual bundled-driver socket via CERT_REQUIRED/check_hostname and a service-DNS SniEndPoint; discovered peer endpoints are refused; OpenSearch uses certificate-validated HTTPS. Redis and
ClickHouse use their private application protocols behind required STRICT
Istio mTLS. Probe-specific `ISTIO_MUTUAL` DestinationRules validate the target
`spiffe://cluster.local/ns/greenguard/sa/default` identity. Redis/ClickHouse server
sidecar injection, these destination identities, CNI enforcement and mesh wire
TLS must be proved in EKS; offline render does not prove encrypted traffic.
Cassandra has native TLS and no mesh sidecar, matching its existing server
profile. Each probe has bounded resources, no Kubernetes token, a writable
scratch volume, projected secret keys and narrow service/port egress. Redis,
Cassandra, OpenSearch and ClickHouse tenant checks exercise fixture key/query
filters; they do not certify the product's complete tenant authorization paths.

The Kafka CLI upstream pin now matches the checked-in broker pin. The owned
Redis vendor source pin matches the checked-in Redis server pin. Redis adds a
fifth exact `data_plane_image_digests` key and a vendor inventory entry; its
signature/provenance review remains pending. Promotion changes the probe image
reference to ECR. Kafka/Redis servers retain their checked-in upstream pins;
server pull ownership/admission must still pass the live signature gate.

### Protected credential preparation

The public helper reads an operator bundle containing `runtime_secret_values`,
preserves its other inputs, and produces a new owned file with mode 0600. Its
public `cell.json` scope must contain exactly account/region/environment/cell
identity and identify a `greenguard-<environment>-...` disposable cell. It
parses the broker PLAIN stanza, rejects duplicate/unsupported JAAS options,
adds the `acceptance-probe` user exactly once, and generates the matching
`acceptance-client-jaas`. It preserves administrator/runtime users and never
changes the broker's `User:broker;User:admin` superuser declaration.
OpenSearch gains two distinct acceptance passwords alongside the distinct
runtime writer/reader pair. Modified `runtime/<secret-name>` version counters
advance; repeating preparation on the updated bundle preserves passwords and
counters. It calls no AWS API and prints no values.

Run this only in the approved protected runner after review, with paths to the
existing protected operator bundle, a new output, and the public Terraform
cell identity:

```sh
python3 infra/gitops/disposable/prepare-acceptance-secrets.py \
  --input "$GG_INPUT_BUNDLE" --output "$GG_ACCEPTANCE_BUNDLE" \
  --scope-file "$GG_PUBLIC_CELL"
```

Load the prepared bundle through the existing protected ephemeral-input path;
do not put its payload in CLI arguments, tracked tfvars, saved plans or logs.
For an existing cell with the earlier two-key OpenSearch AWSCURRENT version,
first publish the prepared four-key input through Terraform's owned write-only
version path with the advanced public version counter, then run secret sync
and readiness. The seeder intentionally rejects the old two-key AWSCURRENT
shape and preserves existing versions; it does not silently rotate or patch
live credentials. If an existing operator bundle omits that source, its
approved preparation must supply the current runtime pair before this helper
can enrich it. Neither this change nor its tests read private bundles.

`ruby infra/gitops/disposable/check-data-plane.rb` renders all five probe Jobs,
checks upstream image ownership and exact topics/ACLs. The acceptance chart
Python tests execute scripts against modeled CLI/API responses, including
absent service, wrong readback, missing TLS CA, missing TTL, wrong tenant,
incorrect ACL acceptance, failed cleanup and stale Job revision. They are
offline checks. Real TLS/authenticated service operations, sidecar lifecycle,
image execution, Argo waits, fixture cleanup, capacity/storage and complete
application tenant isolation remain live EKS gates. `--ready` continues to
fail until those proofs exist.

### Review round 1 runtime corrections

The pinned ClickHouse 25.3.6.56-alpine server image supplies the native client
and Bash; it has no curl. The probe invokes Bash with the 0444 script as its
input and reads escaped credentials from a mode-0600 XML client configuration.
One native session executes all fixture assertions on private port 9000.
NetworkPolicy and mesh AuthorizationPolicy grant that port only to the probe
role / exact probe ServiceAccount. Existing telemetry HTTP access on 8123 is
retained for its telemetry sink identity. The wave-28 server chart grants its
sidecar narrow istiod/15012 egress before server health gates wave 29.

Cassandra's Python probe imports the exact 3.29.0 driver bundled by its owned
5.0.5 image. It passes an SSLContext with CERT_REQUIRED and check_hostname to
all actual CQL control/session/reconnect connections; the SniEndPoint supplies
the service DNS name after IP resolution. Its endpoint factory refuses peer
routing, matching the single-server disposable chart. A separate TLS socket
is no longer used as proof for credential-bearing sessions. The opt-in
`GG_PINNED_CLIENT_SMOKE=1` container tests execute the exact clients with
synthetic credentials, readonly scripts/root filesystems and bounded scratch,
then test a wrong-SAN endpoint signed by the same CA against the real driver's
credential/query connection. These tests use isolated internal networks and
owned ephemeral storage without host ports. They do not prove EKS Istio/CNI,
admission signatures, Argo health or AWS deployment.
