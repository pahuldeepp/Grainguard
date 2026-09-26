# Runbook: RabbitMQ queue backlog, no consumers, memory or disk alarm

**Owner:** notification on-call.  
**Severity:** page for `RabbitMQNoConsumers`, `RabbitMQMemoryAlarm`, `RabbitMQDiskAlarm`; ticket for `RabbitMQTaskBacklog`, `RabbitMQUnackedHigh`, `RabbitMQRetryQueueBacklog`, `RabbitMQUnconfirmedMessages`, `RabbitMQMemoryHigh`, `RabbitMQDiskLow`.  
**Signals:** `rabbitmq_detailed_queue_messages_ready`, `rabbitmq_detailed_queue_messages_unacked`, `rabbitmq_detailed_queue_consumers` (queue metrics), `rabbitmq_channel_messages_unconfirmed`, `rabbitmq_alarms_memory_used_watermark`, `rabbitmq_alarms_free_disk_space_watermark`, `rabbitmq_process_resident_memory_bytes`, `rabbitmq_disk_space_available_bytes` (node metrics). The alarm series exist only while an alarm is active.

Queues: `notifications.tasks` and `notifications.receipts` always have consumers; `notifications.retry` (per-message expiry) and `notifications.dlq` have none by design. Backlog thresholds are candidates until measured under load in Stage 13.

## Symptom

Ready or unacked work is growing, a required queue has no consumers, publisher confirms are backing up, or RabbitMQ reports memory/disk pressure. Retry and DLQ queues intentionally have no consumers.

## Diagnosis

1. `docker exec greenguard-dev-rabbitmq-1 rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers` and `rabbitmq-diagnostics -q alarms`.
2. No consumers: is the notification service or jobs worker running (`up` series, service logs)? Did it lose its connection after a broker restart?
3. Growing ready with consumers present: consumers are slow, blocked on a provider, or the arrival rate exceeds capacity. Growing unacked: consumers hold prefetched tasks while a provider call hangs. Growing retry queue: a provider is failing persistently, see [notification delivery](notification-delivery.md).
4. Alarms: publishers are blocked while an alarm is active; unconfirmed messages climb. Memory is bounded (256 MB container in the local overlay); disk alarm needs free space above the node limit.

## Mitigation

- Restore the consumer or the provider dependency; the backlog drains without intervention.
- Broker restart only if the node is wedged: `make rabbitmq-up` (idempotent). Quorum queues are durable across restarts on the fixed hostname; do not remove the data volume.
- Do not purge queues or delete them. If tasks landed in the DLQ, follow [DLQ growth](rabbitmq-dlq-growth.md).
- Alarm: free memory by draining consumers first; free disk on the broker volume. Raising limits needs a capacity review.

## Verify

Ready and unacked fall, consumers return to at least 1 on `notifications.tasks` and `notifications.receipts`, alarms clear, unconfirmed returns to 0, alerts resolve.

## Escalation

Escalate if an alarm persists for 15 minutes, or if the backlog age threatens notification freshness targets.
