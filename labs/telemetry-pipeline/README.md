# Local telemetry analytics and archive acceptance

`make telemetry-pipeline-e2e` runs a disposable, isolated pipeline:

```text
SASL_SSL Kafka → ClickHouse sink → ClickHouse
             └→ S3 archive sink → MinIO
MinIO archive → verified replay → Kafka
```

The fixture event is schema-validated, then the acceptance checks one logical
ClickHouse row and a checksummed S3 segment. It replays the event once, verifies
that replay metadata is archived, checks that another dry run excludes it, and
confirms the ClickHouse projection remains one logical event. The broker uses
TLS and PLAIN credentials, matching the production client's security protocol.

All credentials and certificates are generated for this run under ignored
`.local/`, and the Make target removes the dedicated Compose project, volumes,
and generated secrets on exit. It does not use AWS credentials, the development
Compose project, or any user telemetry. The stack uses one Kafka broker and one
partition; it proves integration behavior only, not throughput, HA, AWS, or the
production SLOs.
