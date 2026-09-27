# Optional AWS burst-notification profile

The AWS path is reserved for critical notifications. PostgreSQL remains canonical for alert/escalation state and tenant contacts; Debezium CDC publishes the contact table to Kafka, and the contacts projector maintains a DynamoDB contact snapshot. The bridge forwards canonical alert events to EventBridge.

```text
Postgres notification_contacts
  → Debezium/Kafka → idempotent contacts projector → DynamoDB (tenant_id, CONTACTS)
Kafka alert lifecycle → EventBridge bridge → canonical lifecycle bus event
                                           ├→ mirror Lambda → escalation mirror
                                           └→ critical marker → SQS → notification Lambda
                                                                  ├→ DynamoDB contact + delivery-state rows
                                                                  ├→ SES email
                                                                  └→ SNS SMS
```

Critical opened, escalated, and resolved alerts are routed only to EventBridge/SQS/Lambda. `jobs-worker` records inbox evidence but creates no RabbitMQ intents for them. Warning/non-critical email and SMS are routed only through RabbitMQ and the server worker, whose contacts come from the authenticated tenant-control-plane API backed by PostgreSQL. There is no cross-route fallback. The routing split is unconditional; there is no `SERVERLESS_CRITICAL_ENABLED` switch.

The notification-state DynamoDB table uses `(tenant_id, record_key)`: `CONTACTS` is the CDC projection and `DELIVERY#<UUIDv5 intent>` is the per-channel claim/outcome. Stable IDs match `jobs-worker`'s namespace and input tuple. The Lambda takes the tenant only from the validated canonical event. It conditionally writes an `UNKNOWN/send_started` claim before calling SES/SNS; duplicates and ambiguous outcomes are not sent again. DynamoDB and the provider cannot participate in one atomic transaction, so a crash after provider acceptance but before persisting `ACCEPTED` can leave an `UNKNOWN` state. Operators must reconcile provider receipts before any deliberate recovery; there is no automatic resend or RabbitMQ fallback. A missing CDC contact projection is retried and eventually enters the SQS DLQ for operator recovery.

Before reading contacts, and before claiming each channel, the Lambda strongly reads the projector's source checkpoint at `(SYSTEM#NOTIFICATION_CONTACTS_CDC, CONTACTS_FEED_HEARTBEAT)`. Missing/invalid, older-than-60-second or more-than-5-second-future checkpoints fail the SQS record without a new claim or provider send. Recovery restores CDC and then redrives the record; the delivery ledger protects channels already accepted. The freshness bound matches the projector readiness gate, while tenant contact rows need no age limit. The existing table-scoped `dynamodb:GetItem` permission covers the checkpoint; no additional resources or credentials are introduced.

DynamoDB contact data is PII. Restrict Kafka/Schema Registry topic and DLQ ACLs, encrypt in transit/at rest, and do not log contact payloads. Table encryption and point-in-time recovery are enabled; production resources are retained. SES is constrained by configured sender identity. SNS direct SMS publish requires wildcard resource permission in AWS IAM and is region constrained. SQS uses bounded retries/redrive and per-record partial batch failures; DLQ alarms require operator response. Push delivery is deferred.

The private, encrypted, versioned S3 bucket is reserved for a later audit-export integration. This stack does not copy audit exports or alert history into S3.

## Local checks

```bash
make cdk-test
make cdk-synth
make serverless-bridge-test
```

`cdk-synth` validates the template only; it does not deploy or send live notifications. Before enabling the AWS route, configure production Kafka security, verified SES identity, SNS SMS configuration, account parameters, and operator DLQ/reconciliation procedures; then deploy and run cloud acceptance checks.
