# Synthetic scorer deployment artifact

This package is a static, opt-in Helm/Argo CD artifact for the synthetic-only
shadow scorer. The chart is disabled by default; Argo CD sync is manual and
pruning is disabled. It does not provision Kafka, PostgreSQL, Secrets, AWS, or
production model resources. Secret values are never stored in the chart.

## Runtime deployment boundary

The runtime has a separate `cluster-synthetic` profile. It accepts only the
dedicated `postgres.ml-synthetic.svc.cluster.local` service over verified TLS
and Kafka brokers on port 9093 advertised under `.ml-synthetic.svc.cluster.local`
using SASL_SSL/SCRAM-SHA-512. Loopback endpoints, shared namespaces, non-TLS
PostgreSQL, and arbitrary external hosts fail closed. The chart remains disabled
by default and has not been installed into a live Kubernetes cluster.

Other runtime prerequisites remain external: the database schema/migration and
least-privilege RLS role, Kafka input/output topics and ACLs, synthetic tenant
bootstrap, and the externally managed Secret objects referenced by the chart.
There is no chart-owned migration Job.

## Isolated sandbox endpoint contract

The Kafka and PostgreSQL services must be dedicated to namespace
`ml-synthetic`; do not point either at
shared or production services. Defaults are:

- Kafka bootstrap `kafka.ml-synthetic.svc.cluster.local:9093`, SASL_SSL with
  SCRAM-SHA-512 credentials from Secret `ml-scoring-runtime` keys
  `kafka-username`/`kafka-password` and server CA from
  `ml-scoring-kafka-ca/ca.crt`; all broker addresses advertised in
  Kafka metadata must resolve inside this isolated namespace and fit the
  NetworkPolicy selectors/port.
- PostgreSQL URL from external Secret `ml-scoring-runtime/database-url`,
  targeting `postgres.ml-synthetic.svc.cluster.local:5432/greenguard_ml` with
  `sslmode=verify-full`. `PGSSLROOTCERT` points to the external Secret
  `ml-scoring-postgres-ca/root.crt`. Its selected PostgreSQL pods must be in
  namespace `ml-synthetic` on TCP/5432.
- Optional OTLP export is disabled by default. If enabled, it currently targets
  `otel-collector.ml-synthetic.svc.cluster.local:4317` using the configured
  pod selector, also inside the isolated namespace.

Kafka's current input topic name is fixed in runtime code to
`greenguard.telemetry.recorded.v1`, and the shadow output topic is
`greenguard.ml.prediction.shadow.v1`. A future isolated Kafka cluster must put
only synthetic fixture events on that input topic and provision the two topics
and least-privilege ACLs before starting the scorer. The chart does not create
or configure those resources.

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
cluster deployment or network-policy enforcement test has run. Update the image reference, external Secret names,
namespace-local sandbox services/selectors, ports, tenant fixture, topic ACLs,
and Argo revision for the target test cluster. `/readyz` and `/livez` use the runtime's existing
health listener; remote binding requires explicit
`ML_ALLOW_REMOTE_HEALTH_BIND=true`.
