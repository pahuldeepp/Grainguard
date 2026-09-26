# Operational runbooks

Runbooks must name the owner, severity, signals, triage steps, safe recovery, and verification. Rehearsal evidence is required before a stage is complete.

## Stage 11 observability

- [Scrape target down](observability-target-down.md)
- [API errors](api-errors.md)
- [Projection freshness](projection-freshness.md)
- [Kafka / CDC / Rabbit backlog](streaming-backlog.md)
- [Database saturation](database-saturation.md)
- [Notification delivery](notification-delivery.md)
- [Observability backend degraded](observability-backend.md)
- [Kafka consumer lag, stalled group, broker health, binding feed](kafka-consumer-lag.md)
- [Kafka Connect, Debezium connector or Schema Registry down](kafka-connect-failed.md)
- [Replication slot inactive or retaining WAL](kafka-replication-slot.md)
- [RabbitMQ dead-letter queue growth](rabbitmq-dlq-growth.md)
- [RabbitMQ queue backlog, consumers, alarms](rabbitmq-queue-backlog.md)
- [Run the alert failure rehearsal](rehearsal-run.md)
- [Interpret rehearsal failures](rehearsal-failures.md)

The local alert route goes to a test webhook sink. Configure real contact points only in an authorized deployment environment after the sink behavior is verified.
