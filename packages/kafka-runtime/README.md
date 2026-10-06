# Kafka runtime helpers

Shared KafkaJS lifecycle and poison-message handling used by GreenGuard TypeScript consumers. It configures Snappy, creates a manual-commit consumer and producer, publishes invalid messages to a DLQ before advancing offsets, and leaves transient failures uncommitted for retry.

Use `createWorkerClients` and `connectWorker` for the shared client lifecycle, then `processWithDlq` around each message handler. Consumers provide their own contract decoder and invalid-event type so this package does not own domain behavior.

Run `npm test -w @greenguard/kafka-runtime` for unit tests.
