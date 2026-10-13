# Runbook: RabbitMQ dead-letter queue not empty, dead jobs, DLQ publish failures

**Owner:** notification on-call.  
**Severity:** page for `RabbitMQDeadLetterQueueNotEmpty` and `RabbitMQPublishConfirmFailures`; ticket for `JobsDispatchDeadRecords`.  
**Signals:** `rabbitmq_detailed_queue_messages{queue="notifications.dlq"}`, `jobs_dlq_published_total`, `jobs_dlq_publish_failed_total`, `jobs_dispatch_dead_total`, `jobs_redriven_total`. `notifications.dlq` must be empty in steady state; any depth means a task exhausted its delivery limit (5) and was dead-lettered, or the worker recorded a task as dead. See [notification delivery](notification-delivery.md) for provider-side diagnosis.

## Symptom

A dead-letter queue has messages, a DLQ publish confirm failed, or the jobs worker recorded dead records. Check queue depth and sanitized intent metadata before replay.

## Diagnosis

1. Depth and consumers: `docker exec greenguard-dev-rabbitmq-1 rabbitmqctl list_queues name messages consumers` (container name follows the compose project; the overlay service is `rabbitmq`).
2. Why were tasks dead-lettered? Check `notifications.tasks` consumer errors in the notification service and jobs-worker logs, provider errors (timeouts, 5xx, auth), and `x-delivery-limit` redeliveries.
3. `jobs_dlq_publish_failed_total` increasing: the worker could not confirm a publish to the DLQ. The record stays dead in Postgres and can be redriven, but check the broker for memory or disk alarms ([queue backlog](rabbitmq-queue-backlog.md)) and connectivity.
4. Inspect sanitized message metadata only; do not copy tenant payloads into tickets. The DLQ holds metadata-only copies keyed by `intent_id`.

## Mitigation

Fix the cause first (provider outage, credentials, downstream database), then replay:

- `make dlq-replay ARGS="-limit 10"` returns task records to `notifications.tasks` with the same message ID; start small and watch the outcome.
- `make redrive-dead ARGS="-reason 'broker restored' -limit 50"` performs the audited dead-to-pending redrive from Postgres (optionally `-tenant <uuid>`).
- Replays are idempotent by intent and delivery generation; do not purge the DLQ, delete queues or edit rows by hand.
- Provider-specific permanent failures (invalid recipient) should stay dead with a recorded disposition.

## Verify

DLQ depth is 0, `jobs_redriven_total` accounts for the replayed records, no duplicate effect at the provider, alerts resolve. Save before/after counts.

## Escalation

Escalate to the notification owner if the DLQ refills after a replay, or if replay would exceed provider rate limits.
