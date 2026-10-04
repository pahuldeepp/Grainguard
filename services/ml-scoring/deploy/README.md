# Synthetic scorer deployment artifact

This package is a static, opt-in Helm/Argo CD artifact for the synthetic-only
shadow scorer. The chart is disabled by default; Argo CD sync is manual and
pruning is disabled. The scorer chart does not provision Kafka, PostgreSQL, Secrets, AWS, or
production model resources. Secret values are never stored in the chart.

## Runtime deployment boundary

The runtime has a separate `cluster-synthetic` profile. It accepts only the
dedicated `postgres.ml-synthetic.svc.cluster.local` service over verified TLS
and Kafka brokers on port 9093 advertised under `.ml-synthetic.svc.cluster.local`
using SASL_SSL/SCRAM-SHA-512. Loopback endpoints, shared namespaces, non-TLS
PostgreSQL, and arbitrary external hosts fail closed. The chart remains disabled
by default and has not been installed into a live Kubernetes cluster.

The chart includes a bounded Argo CD `PreSync` migration Job. The image carries
the versioned SQL and a separate migration entry point which accepts only the
dedicated verified-TLS `postgres.ml-synthetic` endpoint and the
`greenguard_ml` database. It applies the migrations idempotently and grants the
runtime role only the table privileges used by the shadow scorer. The default
runtime role is `ml_app`, and it must already exist as a non-superuser,
`NOBYPASSRLS` login. The companion `data-chart/` bootstraps a single-node
PostgreSQL database with restricted `ml_migrator`/`ml_app` roles, a single-node
KRaft Kafka broker with TLS/SCRAM, the two exact topics and their scoped ACLs.
Both data services and this scorer chart default to disabled; the parent Argo
tree must sync the data Application and wait for it to become healthy before
syncing this scorer Application. No production topic, database credential, or
real tenant membership is reused. Secret payload generation remains an
operator action and is not stored in this repository.

The migration credential is supplied separately in Secret
`ml-scoring-migrator/database-url`; do not reuse the runtime URL. It must be a
dedicated owner identity for this sandbox database, not an AWS or application
administrator credential. The scorer uses Secret
`ml-scoring-runtime/database-url`, which must authenticate as `ml_app`. Both
URLs must use `sslmode=verify-full` and the mounted
`ml-synthetic-postgres-auth/ca.crt`. Argo CD creates the `ml-synthetic` namespace
when syncing the standalone Application, but sync remains manual and the chart
remains disabled by default.

## Isolated sandbox endpoint contract

The Kafka and PostgreSQL services must be dedicated to namespace
`ml-synthetic`; do not point either at
shared or production services. Defaults are:

- Kafka bootstrap `kafka.ml-synthetic.svc.cluster.local:9093`, SASL_SSL with
  SCRAM-SHA-512 credentials from Secret `ml-scoring-runtime` keys
  `kafka-username`/`kafka-password` and server CA from
  `ml-synthetic-kafka-tls/ca.crt`; all broker addresses advertised in
  Kafka metadata must resolve inside this isolated namespace and fit the
  NetworkPolicy selectors/port.
- PostgreSQL URL from Secret `ml-scoring-runtime/database-url`,
  targeting `postgres.ml-synthetic.svc.cluster.local:5432/greenguard_ml` with
  `sslmode=verify-full`. `PGSSLROOTCERT` points to
  `ml-synthetic-postgres-auth/ca.crt`. Its PostgreSQL pod must be in
  namespace `ml-synthetic` on TCP/5432.
- OTLP export is enabled when the opt-in scorer chart is enabled. It targets
  `otel-collector.greenguard.svc.cluster.local:4317` using the configured
  collector pod selector in the shared observability namespace.

Kafka's current input topic name is fixed in runtime code to
`greenguard.telemetry.recorded.v1`, and the shadow output topic is
`greenguard.ml.prediction.shadow.v1`. The companion data chart creates the two
topics and least-privilege ACLs before the scorer Application is synced. Only
synthetic fixture events may be published to the input topic. The scorer principal needs
read access to the input topic and its consumer group, and write access only to
the shadow topic. The data chart creates those topics and ACLs. The optional
scorer-chart fixture Job is disabled by default; an operator may explicitly set
`syntheticFixtureSeed.enabled=true` to publish at most 384 deterministic-schema
synthetic events after the scorer is healthy. It uses the separate
`ml-scoring-fixture` credential and cannot address another broker or topic.

The scorer's operations snapshot only accepts its fixed synthetic tenant UUID.
The BFF obtains `tenant_id` from the authenticated principal, so the snapshot
will be denied unless an explicitly authorized synthetic test principal uses
that exact tenant. Do not map the synthetic tenant to ordinary customer users;
real OIDC membership bootstrap and the public product operations view are
separate integration work.

## Image

Build from the repository root so the Dockerfile can copy the scorer source,
its model architecture module, and the immutable synthetic model bundle:

```sh
docker build -f services/ml-scoring/deploy/Dockerfile \
  -t greenguard/ml-scoring-synthetic:i4-transformer-bcf286ab98d45f8c .
```

The Python base image is pinned by version and OCI index digest. The scorer
image uses the CPU-only PyTorch wheel index and a universal Python 3.14 lock
with wheel hashes; the public PyPI index supplies the remaining dependencies.
Regenerate the lock from the repository root with:

```sh
uv pip compile services/ml-scoring/requirements.txt \
  --python-version 3.14 --universal --generate-hashes --torch-backend cpu \
  --output-file services/ml-scoring/deploy/requirements.lock
```

Keep `--universal` and `--torch-backend cpu`: the former records platform
markers, and the latter selects CPU PyTorch wheels instead of CUDA-dependent
Linux wheels. Docker installation uses `--require-hashes`; do not remove that
check to work around a lock failure.
The image runs the existing
`python -m ml_scoring.main` entry point as UID/GID 10001.

## Review before enabling

Do not set `enabled=true` outside a disposable cluster containing only
synthetic fixtures. The profile enforces endpoint/TLS isolation, but no live
cluster deployment or network-policy enforcement test has run. The migration
Job will fail closed unless its Secret targets exactly the dedicated PostgreSQL
service with verified TLS and the runtime role is present with `NOBYPASSRLS`.
Provision all required Secrets/CA data, database roles, isolated Kafka topics,
and synthetic tenant/test-user membership before manually syncing the
Application. Do not reuse the production telemetry topic or a real tenant's
database credential. Update the immutable image, endpoint credentials, tenant
fixture, topic ACLs, and Argo revision for the disposable sandbox. `/readyz` and
`/livez` use the runtime's existing health listener; remote binding requires
explicit `ML_ALLOW_REMOTE_HEALTH_BIND=true`.
