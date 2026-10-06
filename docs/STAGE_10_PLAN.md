# Stage 10 — Technology profiles and adapters

Stage 10 adds alternate technology profiles behind the existing GreenGuard contracts. Each profile must remain opt-in, have a reproducible local command, and run the same acceptance suite as its primary adapter. A profile is complete only after runtime behavior, failure/retry semantics, tenant isolation and saved evidence are verified. It must not create a second authoritative owner for existing domain state. **10a passed locally. 10b has local implementation and test evidence, with AWS deployment/cloud acceptance pending. 10c passed its post-fix local live run (30/30 tests plus `STAGE10C_LIVE_PASS`); independent review is approved and final CodeRabbit review returned 0 findings. Remote `mysql-cdc-integration` CI remains pending. 10d has a local warning-path routing proof; critical AWS delivery and contact CDC recovery/lag proof remain pending.** Slices 10e–10f remain in progress or pending.

## Work slices

| Slice | Scope | Acceptance |
|---|---|---|
| 10a | OpenSearch search-store profile | **Passed locally** — [Stage 10a evidence](../evidence/STAGE_10A_OPENSEARCH_VALIDATION.md): pinned local image, 20 contract tests and live acceptance suite pass for indexing, replay/idempotency, tenant filtering, manifest comparison, write fencing and atomic alias promotion. Profile stays isolated from Elasticsearch. |
| 10b | DynamoDB adapters for OpenFeature/configuration and escalation mirror; CDK/S3/Lambda/SQS/EventBridge profile | **Local implementation/tests verified; AWS acceptance pending** — [DynamoDB/Kafka evidence](../evidence/STAGE_10B_DYNAMODB_PROGRESS.md) and [serverless profile evidence](../evidence/STAGE_10B_SERVERLESS_PROFILE.md): flag snapshots, live Kafka projection, CDK/Lambda profile and severity-exclusive serverless bridge have local evidence. Latest local checks: 12/12 DynamoDB Local flag tests, 6/6 bridge tests, 34/34 CDK tests and synth. The standalone escalation mirror has not been live-tested. No AWS deployment, real provider send or cloud acceptance has occurred; whole-tree gates remain pending. |
| 10c | MySQL import and CDC profile with SQLAlchemy/Alembic | **Local post-fix acceptance passed; remote CI pending** — [evidence](../evidence/STAGE_10C_MYSQL_CDC_VALIDATION.md). `make mysql-cdc-test` exited 0 with 30/30 tests, `STAGE10C_LIVE_PASS`, and cleanup; independent review approved and final CodeRabbit review reported 0 findings. Remote `mysql-cdc-integration` CI remains pending. PostgreSQL remains canonical; the importer cannot write its tables directly. |
| 10d | Severity-routed notification provider adapters | PostgreSQL is the authoritative contact store; a dedicated Debezium table connector is intended to snapshot and stream versioned contacts through Kafka into a DynamoDB projection for the critical path. Locally verified: warning event replay yields one inbox record and two delivery intents, with its temporary test topic removed; bridge tests (6/6), CDK tests (34/34 + synth), and DynamoDB Local tests (12/12) pass. This does not prove the critical EventBridge/SQS/Lambda/provider path or contact CDC recovery/lag. Critical → EventBridge/SQS/Lambda → DynamoDB lookup → SES/SNS. Warning/non-critical → RabbitMQ worker → authenticated Control Plane lookup backed by PostgreSQL → SendGrid/Twilio. AWS deployment/provider acceptance remains environment-specific. |
| 10e | React Native mobile alert and acknowledgement journey | OIDC Authorization Code + PKCE with secure token storage; tenant switch and token expiry; authenticated alert list/detail/ack through the BFF; offline/reconnect and duplicate ack; accessibility and browser/device test commands documented. |
| 10f | Synthetic FHIR R4 clinical reference lab | Isolated synthetic FHIR data and reference workflow tests; no clinical schemas, formulas or derived values can enter grain telemetry/risk topics. |

## Order

1. Complete 10a against the existing search port and save a local live-test transcript.
2. Build 10b and 10c as isolated, opt-in profiles; complete contract and recovery tests before adding deployment integration.
3. Build 10d around PostgreSQL contacts as source of truth, a Debezium table CDC → Avro Schema Registry → Kafka → DynamoDB projection, critical Lambda delivery-state records, and the existing RabbitMQ warning delivery ledger; keep severity routing exclusive so a logical notification never enters both paths.
4. Build 10e and 10f as separate products with independent tenant/auth/data boundaries.
5. Run the whole-tree gates, coverage/Sonar, CodeRabbit and remote CI after the slices stabilize; update milestone rows only from their actual evidence.

## Current boundary

Stage 09 sandbox checkout/IdP proofs and its final live/whole-tree gates are tracked separately. Stage 10 local profiles do not claim a completed Stripe checkout, production Auth0 setup, cloud deployment or capacity certification. Cloud-backed proof requires the owner’s sandbox/account configuration.
