# Stage 10b DynamoDB progress

Date: 2026-09-26

## Delivered in this slice

- Added a DynamoDB Local profile pinned by image digest and isolated to `127.0.0.1:28000`.
- Added `DynamoFlagSnapshotStore`, using a tenant-scoped key and conditional monotonic writes. Global configuration has a separate reserved key; stale/out-of-order updates cannot replace a newer snapshot. The adapter does not use TTL for correctness.
- Added an optional notification-service consumer for `greenguard.platform.config.v1`. Its Kafka message handler awaits DynamoDB persistence, so KafkaJS does not complete/commit an event before the durable write. It uses an independent consumer group from the in-memory cache feed.
- Added unit coverage for persist-before-complete ordering, malformed events, persistence failure, retries, and DynamoDB tenant/version behavior.
- The opt-in CDK/Lambda/EventBridge/SQS profile and Kafka-to-EventBridge critical-only bridge are also implemented locally. The bridge and jobs-worker route critical notifications exclusively to the serverless path; warning/non-critical notifications remain on RabbitMQ. This does not establish live behavior for the standalone escalation mirror.

## Verification

- `npm test -w @greenguard/feature-flags`: passed; DynamoDB live test was initially skipped when run without its opt-in environment.
- `DYNAMODB_LIVE=1 DYNAMODB_ENDPOINT=http://127.0.0.1:28000 npm test -w @greenguard/feature-flags`: passed with DynamoDB Local.
- `npm test -w services/notification-service`: passed after the concurrent Stage 09 flag-feed edits settled (22 pass, 17 opt-in/live tests skipped).
- `make stage10b-kafka-test`: passed; it started the local DynamoDB and Kafka/Connect prerequisites, applied migrations, and verified that a real Kafka event was read and persisted to DynamoDB Local with the expected tenant snapshot.
- Latest local checks: **12/12** DynamoDB Local flag tests, **6/6** serverless bridge tests, **34/34** CDK tests, and local CDK synthesis passed.
- Feature-flags and notification-service typechecks passed before the latest concurrent Stage 09 edits. An intermediate notification-service build hit the same unrelated `flag-feed.test.ts` compile errors; the documented live target subsequently rebuilt and passed after those concurrent edits settled.

## Still open for 10b

The local implementation and tests do not complete Stage 10b. No AWS deployment, real provider send or cloud acceptance has occurred. The standalone DynamoDB escalation mirror has not been live-tested for parity/recovery. Whole-tree verification, coverage/Sonar and remote CI are also pending.
