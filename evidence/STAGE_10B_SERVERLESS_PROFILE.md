# Stage 10b optional AWS critical-notification profile — local evidence

PostgreSQL and Kafka remain canonical. The AWS profile is an optional critical-alert delivery path; warning/non-critical notifications continue through RabbitMQ. `SERVERLESS_CRITICAL_ENABLED` is false by default and must match between the Kafka bridge and jobs-worker. When enabled, only critical `alert.opened`, `alert.escalated`, and `alert.resolved` transitions use the AWS path. The jobs-worker keeps inbox evidence but creates no RabbitMQ intents for those transitions, preventing dual delivery. The bridge emits a separate `alert.critical.serverless` transport marker; it does not alter the canonical event body.

Implemented locally:

- Kafka-to-EventBridge bridge with manual offset commits after successful bus delivery or metadata-only poison quarantine. Retriable AWS errors leave offsets uncommitted.
- Severity-exclusive route in the bridge and jobs-worker, using the same intent-ID algorithm as the existing notification ledger.
- CDK EventBridge bus/rules, version-fenced tenant-keyed DynamoDB escalation mirror, separately bounded mirror and notification Lambdas, dedicated DLQs for EventBridge delivery, Lambda invocation and SQS dispatch failures, CloudWatch queue-depth alarms, bridge IAM role/quarantine queue, Secrets Manager token reference/cache, and private encrypted/versioned S3 audit archive bucket.
- SQS dispatch Lambda plus authenticated internal notification-service ingress. The endpoint checks the bearer token, canonical idempotency key and tenant header, then publishes deterministic per-channel tasks to the existing RabbitMQ provider worker.
- Unit/template tests cover route split, poison handling, tenant/event validation, idempotency IDs, conditional version writes, SQS partial batch failure, retry and resource boundaries.

Validation on 2026-09-26:

- `cd services/jobs-worker && go test ./...` — passed; database-backed tests skip unless `JOBS_DIRECT_URL` is configured.
- `npm test -w @greenguard/notification-service` — passed, 23 passed and 17 database/live tests skipped because `NOTIFICATIONS_DIRECT_URL` is not configured.
- `make serverless-bridge-test` — passed, 6 tests, including critical-only markers, warning exclusion and disabled-mode behavior.
- `make cdk-test cdk-synth` — passed; latest result is 34/34 CDK/Lambda tests and local synthesis.
- `npm test -w @greenguard/notification-service` — passed, 23 passed and 17 database/live tests skipped because `NOTIFICATIONS_DIRECT_URL` is not configured.
- `npm run typecheck -w @greenguard/notification-service` — passed.
- `cd services/jobs-worker && go test ./...` — passed; database-backed tests skip unless `JOBS_DIRECT_URL` is configured.
- `make check-plan` and `git diff --check` — passed.
- CodeRabbit reviewed the CDK scope. Findings led to fixes for per-record failure isolation, SQS batch/visibility timing, invocation-deadline checks, distinct delivery and processing DLQs, bounded secret caching, test state cleanup, queue-depth alarms and safe HTTP-status diagnostics. The final review reported no new findings; the prior stored finding was resolved and cleared.
- `make stage10d-routing-live-test` — passed using a unique temporary Kafka topic: replay of a warning event yielded exactly one inbox record and two delivery intents, then the test removed the temporary topic.
- Latest focused adapter checks: `make serverless-bridge-test` passed 6/6 and DynamoDB Local flag tests passed 12/12.

Still required before production use and before calling the critical delivery path end-to-end verified:

1. Prove the critical route through EventBridge/SQS/Lambda and SES/SNS in an AWS sandbox or equivalent integration environment, including crash-before-commit, retry, tenant isolation, provider outcomes, and duplicate cases. The local warning-path topic test does not exercise critical delivery.
2. Prove contact CDC recovery and lag behavior, including connector restart/replay, version fencing, and recovery from DynamoDB projection failure.
3. Configure authenticated production Kafka access, the same `SERVERLESS_CRITICAL_ENABLED=true` value for bridge and jobs-worker, internal HTTPS routing from Lambda to notification-service, and the Secrets Manager credential.
4. Deploy in the target AWS account and run IAM/network, DLQ, tenant-isolation, provider idempotency, and recovery acceptance tests; connect CloudWatch alarm actions to the operator notification target. No AWS account was accessed and no resources were deployed during local validation.

Therefore, the local warning route and critical-path infrastructure/unit checks are verified, but critical AWS delivery, contact CDC recovery/lag behavior, and cloud acceptance remain **in progress**. Keep `SERVERLESS_CRITICAL_ENABLED=false` until matching deployment and cloud acceptance checks pass.
