# Telemetry sinks

This service runs as two independent Kafka consumer deployments selected by the
container argument:

* `clickhouse` writes validated `greenguard.telemetry.recorded.v1` and `.v2`
  events to `greenguard_analytics.telemetry_events` using the ClickHouse HTTP
  interface. The complete canonical event is retained in `event_json`; typed
  aggregate columns are populated where the event contract has matching values.
* `s3-archive` stores immutable, deterministic gzip JSONL segments under the
  dedicated bucket's `telemetry/segments/` prefix. Each line preserves the
  source topic, partition, offset, original Kafka key/value bytes, and payload
  digest. Bucket versioning/encryption and workload identity are configured by
  the deployment infrastructure.

Both modes validate the repository's versioned event schemas, Kafka key,
traceparent, timestamps, and source coordinates. Invalid events fail closed and
leave the offset uncommitted; an operator must remediate the poison record before
that partition can progress. Batches are bounded by 500 records, 1 MiB, and one
second. Writes are retried with exponential backoff and a 60-second normal
budget; graceful shutdown allows a bounded 20-second drain. Kafka offsets are
committed only after ClickHouse confirms an insert or S3 confirms the immutable
object. S3 uses a conditional create and verifies metadata plus the S3 SHA-256
checksum on replay.

ClickHouse receives deterministic insert deduplication tokens and uses the
table's `ReplacingMergeTree`. This is at-least-once delivery with storage-side
deduplication; queries requiring immediate logical deduplication should use
`FINAL`. ClickHouse's deduplication window is finite, so it is not a permanent
exactly-once guarantee. S3 archive segments are immutable and keyed by their
first source offset; a restart recovers a segment before advancing the Kafka
group offset.

Runtime configuration is injected from Kubernetes Secrets and workload
identity, never baked into the image:

* Both modes: `KAFKA_BROKERS`, `KAFKA_SECURITY_PROTOCOL=SASL_SSL`,
  `KAFKA_SASL_MECHANISM=PLAIN`, `KAFKA_SASL_USERNAME`,
  `KAFKA_SASL_PASSWORD`, and mounted `KAFKA_TLS_CA_FILE`.
* ClickHouse: `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, and `CLICKHOUSE_PASSWORD`.
* S3: `TELEMETRY_ARCHIVE_BUCKET` and `AWS_REGION` plus the pod's scoped AWS
  workload identity.

The health server exposes `/healthz`, `/readyz`, and fixed-cardinality
Prometheus metrics on port 8080. Readiness requires Kafka assignment, a recent
consumer poll, and a successful sink dependency check. The two Helm profiles
enable startup, readiness, and liveness probes against those health endpoints.
Prometheus scraping still requires separate authenticated scrape configuration
and has not been proven against a running cluster.

## Local tests

From the repository root:

```sh
python3 -m venv /tmp/greenguard-telemetry-sinks-venv
/tmp/greenguard-telemetry-sinks-venv/bin/pip install -r services/telemetry-sinks/requirements.txt
/tmp/greenguard-telemetry-sinks-venv/bin/python -m unittest discover -s services/telemetry-sinks/tests -v
```

These tests use a local HTTP stub and an in-memory S3-compatible fake. They do
not prove connectivity to a live Kafka cluster, ClickHouse, or AWS S3.
