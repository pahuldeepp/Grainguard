# Disposable PgBouncer and streaming bootstrap

These standalone Helm charts are offline implementation slices. PgBouncer,
Kafka topics, Connect, connector registration, OpenSearch and Cassandra have conditional child Applications in
the disposable Argo tree; MQTT is still an isolated candidate
charts. `terraform apply` still has a closed readiness gate. Run
`ruby infra/gitops/disposable/check-data-plane.rb` for shape and inventory
checks; `--ready` deliberately fails with the missing prerequisites.

## Required order

1. The wave-10 data Application brings up Kafka without Schema Registry.
   The wave-12 `streaming-topics-chart` Jobs apply ACLs and create and verify the 39 exact
   topics from `scripts/kafka-topics.mjs`, including `_schemas`, Connect's
   internal topics, and Debezium heartbeat topics. The chart's copy is
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
   MQTT remains unwired because device access and credentials are incomplete.
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
