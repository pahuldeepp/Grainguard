# Disposable RabbitMQ, Redis Cluster, and Kafka slice

These manifests are a **single-cell data slice** with one RabbitMQ node, one
Kafka KRaft broker/controller, one Schema Registry, and six Redis nodes. They
are not yet wired into Terraform apply or Argo CD. Do not remove the Terraform
readiness gate based on their presence. `ruby check-contract.rb` validates
their offline shape; only an EKS run can prove images, scheduling, CSI volumes,
broker initialization, service credentials, network policy, and application
connectivity.

The exact `aws-ebs-csi-driver` add-on version is an operator-supplied pinned
Terraform variable. `storageclass.yaml` provisions encrypted gp3 EBS volumes
with `reclaimPolicy: Delete`. RabbitMQ has an 8 GiB claim. Six Redis nodes
have 2 GiB claims each and form three masters with three replicas. Kafka has a
16 GiB claim, and Schema Registry uses the Kafka-backed `_schemas` topic. Redis
uses AOF and a 256 MiB per-node cache cap. The search indexer has a separate
8 GiB encrypted gp3 `search-indexer-quarantine` claim for poison records; it
must be created before that worker and removed with the disposable namespace.
The pinned image digests match the
local Compose inventory. These are disposable capacity choices, not
production availability sizing.

## Preconditions and ordering

1. Install the EBS CSI add-on and wait for the controller and node plugin.
2. Install the StorageClass, then create a Kubernetes Secret named
   `greenguard-data-credentials` in namespace `greenguard`. It must contain
   `REDIS_PASSWORD`, `RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS`, and
   `RABBITMQ_ERLANG_COOKIE`. Generate high-entropy values outside source
   control, provision from the cell's approved secret workflow, and verify
   the references resolve. The manifests contain no secret values and fail
   to start when the Secret or a key is missing.
3. Apply the StatefulSets, Services, Deployment, and NetworkPolicies. Redis uses parallel
   pod management because all six nodes must start before cluster formation.
4. Wait for Kafka and Schema Registry readiness, then provision the exact
   topics in `scripts/kafka-topics.mjs` and register checked-in schemas through
   `scripts/contacts-schema.mjs` and the connector flow. Their local command
   wrappers target Docker Compose, so an EKS migration Job or equivalent still
   needs to be built.
   Topic auto-creation is disabled. Connect and connector registration are
   also missing; these manifests alone cannot carry GreenGuard events.
5. Run the `redis-cluster-bootstrap` Job after the six Redis Pods answer
   authenticated `PING`. It is idempotent when the cluster is already healthy.
   Wait for Job completion, then six `Ready` Redis Pods and one `Ready`
   RabbitMQ Pod. The Redis readiness probe requires `cluster_state:ok`.
6. Configure clients with the internal pod endpoints
   `redis-cluster-{0..5}.redis-headless.greenguard.svc.cluster.local:6379` and
   `rabbitmq.greenguard.svc.cluster.local:5672`, using credentials from the
   same secret. Test slot routing and a Redis failover before claiming the
   BFF, membership cache, and live alert paths work.

The NetworkPolicies allow only Pods in the `greenguard` namespace to reach
the client ports. Redis cluster-bus traffic is limited to Redis Pods. Nothing
is exposed with a LoadBalancer. Broker traffic is plain TCP inside the pod
network until Istio mTLS is deployed and proven; NetworkPolicy alone does not
encrypt it. RabbitMQ authentication is required, but this single node is not
highly available. Kafka has no SASL/ACL in this disposable manifest and carries
tenant data, so broker authorization and mesh transport policy are blocking
security gaps. Redis persistence does not replace PostgreSQL authority or
prove cache recovery behavior. A single Kafka broker is not an availability
or Stage 13 scale proof.

`ruby check-contract.rb --ready` deliberately fails while these security and
live connectivity gaps remain. The normal check only validates manifest shape.
Moving Kafka to SASL/TLS requires coordinated configuration in every client:
Go `kafka-go` readers/writers, Python `confluent_kafka`, Node `kafkajs`, Kafka
Connect, Schema Registry, topic/schema bootstrap jobs, and test utilities.
The current application clients generally pass only `KAFKA_BROKERS` and use
the default plaintext protocol; changing the broker alone would stop event
processing. RabbitMQ clients use `RABBITMQ_URL` (including jobs-worker and
notification-service), so the deployed URL must contain the generated user
and password and be tested against the real broker. Redis clients must receive
password-bearing node URLs for all six advertised cluster hosts, including
read-api and cache-invalidator. Mesh mTLS on each of these connections has to
be proven with an actual EKS packet/policy test; these manifests do not prove
transport encryption or per-client authorization.

## Teardown

`pre-destroy.sh` records exact EBS volume IDs from GreenGuard PVs, then stops
the three named StatefulSets before deleting PVCs; it
then waits for Kubernetes-owned load balancers. The EBS CSI add-on is a
Terraform dependency of that hook, so the driver remains while claims are
deleted. Argo CD reconciliation must be stopped before this sequence to keep
it from recreating StatefulSets or claims. The final AWS inventory reports
unattached Kubernetes EBS volumes, but live acceptance must also verify all
EBS volumes created for these claims are gone before declaring zero cost.
