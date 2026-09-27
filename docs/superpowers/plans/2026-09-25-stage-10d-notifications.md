# Stage 10d — severity-routed notification providers

## Objective
PostgreSQL remains the authoritative notification-contact store. The tenant control plane updates contacts in PostgreSQL. A dedicated Debezium PostgreSQL table connector snapshots and streams the versioned `notification_contacts` table into a tenant-keyed compacted Kafka topic; a projection consumer conditionally upserts the latest row into DynamoDB. The API does not write a second store or an outbox event for this projection. Critical EventBridge/SQS/Lambda reads the DynamoDB projection and sends through SES/SNS. Warning/non-critical RabbitMQ workers resolve directly from PostgreSQL through the authenticated Control Plane lookup and send through SendGrid/Twilio. Critical and warning routes are exclusive.

## Global constraints
- Never route one logical alert/channel to both delivery paths.
- PostgreSQL is the sole contact system of record; do not dual-write PostgreSQL and DynamoDB from the API.
- The dedicated Debezium table CDC connector is the only PostgreSQL → Kafka → DynamoDB synchronization path; never dual-write DDB from the API.
- Each path reads contacts by validated tenant identity from its designated store: PG lookup for server-based warnings, DDB projection for serverless critical alerts. Never accept recipient addresses or tenant scope from alert payloads.
- Contact CDC rows contain PII. Restrict access to the contact topic and DLQ, use Kafka TLS/encryption at rest in deployed environments, avoid logging payloads, and compact by tenant key so only the latest state is retained for rebuild.
- The DynamoDB projector must apply monotonically increasing versions, tolerate duplicates/reordering, and make deletes/clears explicit; it must expose lag and quarantine invalid events without leaking contact fields.
- Keep deterministic intent IDs stable across retries on each delivery path.
- External providers do not guarantee exactly-once. Ambiguous acceptance stays unknown and is not blindly resent or failed over to the other path.
- Stage 10d sends email and SMS only. Push is deferred to Stage 10e.
- No real credentials, external sends, cloud deployments, or commits in this task. Use local fakes and focused tests.

## Task 1: PostgreSQL contacts source of truth
Tenant-admin authorization, validation and versioned contact API/table are implemented and previously reviewed. The current CDC hardening adds a scoped read publication/policy for the dedicated Debezium table connector and allows an explicit both-null versioned row so DynamoDB can represent “no destinations” without deleting the monotonic version. No API-side DDB write and no separate outbox event are needed. Migration review is in progress for check-constraint correctness.

## Task 2: non-critical provider adapters
Implemented and focused-reviewed; build/tests pass. Independent code review initially found HTTPS and pre-dispatch retry classification issues; both are fixed and re-reviewed PASS. Implement SendGrid email and Twilio SMS for warning/non-critical severity. Critical SES/SNS belongs in Lambda. Export a selector `(severity, channel)` and injected authenticated Control Plane resolver (`CONTROL_PLANE_URL` + `CONTROL_LOOKUP_TOKEN`) calling the PG-backed internal contacts GET endpoint. The warning worker must not read DDB. Use safe templates, bounded timeouts and environment credentials. Known rejections/transients must be distinguished from ambiguous acceptance; unsupported provider reconciliation returns `unknown`, never `not_found`. No control-plane, CDK or routing edits.

## Task 3: CDC → DynamoDB contact projector
Add a dedicated Debezium PostgreSQL table connector for `notification_contacts`, with initial snapshot and persisted replication slot/offsets. Route its tenant-keyed table records into a compacted Kafka topic, then consume that CDC topic in an isolated projector that writes the DynamoDB `CONTACTS` item. Use `(tenant_id, record_key="CONTACTS")`, fields `email`, `sms`, and `version`. Apply only a strictly newer version with conditional writes; duplicate or stale events are harmless. Define explicit clearing/deletion semantics. Commit Kafka offsets only after successful DDB projection; retry transient errors; quarantine invalid payloads without logging contact values. Add lag/health/metrics and crash/replay tests. Topic/ACL/retention guidance must acknowledge that contact events contain PII. Keep the service small and isolated from notification provider sends.

## Task 4: critical Lambda and exclusive routing
Change the critical Lambda to read tenant contacts and per-channel delivery state from DynamoDB and send via SES/SNS; it must not call notification-service or PostgreSQL. Add/retain the DynamoDB table with partition `tenant_id`, sort `record_key`, contact key `CONTACTS`, delivery keys `DELIVERY#<intent_id>`. Use conditional delivery-state writes and do not claim atomic exactly-once external send. Critical alerts go only to EventBridge/SQS/Lambda. Warning/non-critical email/SMS go only through RabbitMQ. Remove critical push intents. Test the routing matrix, duplicate and tenant-mismatch behavior, missing/lagging contact projection, SES/SNS failures, and DLQ/operator recovery.

## Acceptance
- Focused control-plane, contract/CDC, DDB projector, notification-service, Lambda and CDK tests pass.
- PostgreSQL remains source of truth; the Debezium snapshot/WAL stream is the only DDB synchronization path; no API-side DDB dual write.
- CDC replay/restart updates DynamoDB idempotently and never regresses a tenant contact version.
- Warning worker resolves trusted contacts from PostgreSQL via authenticated Control Plane lookup; only critical Lambda reads the DynamoDB projection.
- Critical uses SES/SNS only; warning uses SendGrid/Twilio only; no cross-path fallback.
- Replayed alert events retain stable intent IDs; terminal outcomes do not trigger repeated sends.
- No real provider credentials or sends are used in tests.
