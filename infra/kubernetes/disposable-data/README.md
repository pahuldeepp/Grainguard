# Disposable RabbitMQ and Redis Cluster slice

These manifests are a **single-cell, single-RabbitMQ-node** data slice. They
are not yet wired into Terraform apply or Argo CD. Do not remove the Terraform
readiness gate based on their presence. `ruby check-contract.rb` validates
their offline shape; only an EKS run can prove images, scheduling, CSI volumes,
broker initialization, service credentials, network policy, and application
connectivity.

The exact `aws-ebs-csi-driver` add-on version is an operator-supplied pinned
Terraform variable. `storageclass.yaml` provisions encrypted gp3 EBS volumes
with `reclaimPolicy: Delete`. RabbitMQ has an 8 GiB claim. Six Redis nodes
have 2 GiB claims each and form three masters with three replicas. Redis
uses AOF and a 256 MiB per-node cache cap. The pinned image digests match the
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
3. Apply the StatefulSets, Services and NetworkPolicies. Redis uses parallel
   pod management because all six nodes must start before cluster formation.
4. Run the `redis-cluster-bootstrap` Job after the six Redis Pods answer
   authenticated `PING`. It is idempotent when the cluster is already healthy.
   Wait for Job completion, then six `Ready` Redis Pods and one `Ready`
   RabbitMQ Pod. The Redis readiness probe requires `cluster_state:ok`.
5. Configure clients with the internal pod endpoints
   `redis-cluster-{0..5}.redis-headless.greenguard.svc.cluster.local:6379` and
   `rabbitmq.greenguard.svc.cluster.local:5672`, using credentials from the
   same secret. Test slot routing and a Redis failover before claiming the
   BFF, membership cache, and live alert paths work.

The NetworkPolicies allow only Pods in the `greenguard` namespace to reach
the client ports. Redis cluster-bus traffic is limited to Redis Pods. Nothing
is exposed with a LoadBalancer. Broker traffic is plain TCP inside the pod
network until Istio mTLS is deployed and proven; NetworkPolicy alone does not
encrypt it. RabbitMQ authentication is required, but this single node is not
highly available. Redis persistence does not replace PostgreSQL authority or
prove cache recovery behavior.

## Teardown

`pre-destroy.sh` records exact EBS volume IDs from GreenGuard PVs, then stops
the two named StatefulSets before deleting PVCs; it
then waits for Kubernetes-owned load balancers. The EBS CSI add-on is a
Terraform dependency of that hook, so the driver remains while claims are
deleted. Argo CD reconciliation must be stopped before this sequence to keep
it from recreating StatefulSets or claims. The final AWS inventory reports
unattached Kubernetes EBS volumes, but live acceptance must also verify all
EBS volumes created for these claims are gone before declaring zero cost.
