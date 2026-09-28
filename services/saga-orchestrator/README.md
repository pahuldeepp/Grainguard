# services/saga-orchestrator

Status: **Stage 07 provisioning saga, compensation, repair and leased/fenced coordination implemented; local live gate passes (`make stage07-e2e`), remote CI pending**.

Stages: 07.

Technology: Go, Postgres, Kafka.

Responsibility: Durable provisioning state machine, retry and compensation.

The HTTP API (`go run ./cmd/api`) binds to `127.0.0.1:8092` by default. Set
`SAGA_API_ADDR` to override the bind address. For mutual TLS, set all three
`SAGA_API_TLS_CERT_FILE` (server certificate PEM), `SAGA_API_TLS_KEY_FILE`
(matching private key PEM), and `SAGA_API_TLS_CLIENT_CA_FILE` (PEM trust roots
for client certificates). Startup fails if only some are set, the files cannot
be loaded, or the client CA contains no valid certificates. Mutual TLS requires
TLS 1.3 and a valid client certificate signed by that CA on every connection,
including `/healthz`. JWT validation and role checks still apply to provisioning
routes after the TLS handshake. Without the three TLS variables, the local
loopback HTTP workflow remains available; use the TLS settings before binding
the API to a non-loopback production interface. Callers such as the BFF must
trust the server CA and present their client certificate and key.

For local Dex sign-in, point `AUTH_ISSUER`, `AUTH_JWKS_URL`, and `AUTH_AUDIENCE`
at the same identity and audience used by the BFF, and set
`AUTH_MEMBERSHIP_FILE=infra/oidc/memberships.json` (absolute path when launched
from another directory). The API verifies the RS256 JWT before it looks up
`issuer|subject` in that file. The mapped tenant and roles replace any claims
from the IdP; unmapped identities and malformed files fail closed. The file is
read on each request so local membership removal revokes saga API access without
restarting that process. The BFF and Read API currently load the same file at
startup, so this does not provide platform-wide immediate revocation. With no
membership file, the existing signed
`tenant_id`/`roles` test-issuer path remains available. Stage 09 replaces the
local fixture with a durable membership authority and audit.

The Stage 07 transport worker (`go run ./cmd/worker`) publishes the durable
`saga_command_outbox` to `greenguard.saga.commands.v1` and consumes definitive
participant outcomes from `greenguard.saga.results.v1`. Both topics use
`tenant_id:saga_id` as the Kafka key. Commands retain their database-generated
`command_id` across broker retries and crashes; participants must deduplicate
that ID. The worker marks an outbox row published only after an all-ISR Kafka
acknowledgement. It commits a result offset only after the tenant-scoped result
transaction commits. Malformed, stale, or unavailable results stop the consumer
without advancing the offset, so an operator can repair the cause and restart it.

`SAGA_DATABASE_URL` and `KAFKA_BROKERS` are required. `SAGA_METRICS_ADDR`
(optional) serves `/metrics` from the worker; the API serves `/metrics` on its
own listener. Gauges come from the count-only SECURITY DEFINER functions in
migration `000006` (`saga_state_count{state}`, `saga_repair_required`,
`saga_compensation_backlog`, `saga_deadline_overdue`, `saga_commands_pending`,
`saga_commands_oldest_pending_seconds`); counters and the
`saga_step_latency_seconds{step}` histogram are per process. No metric has a
tenant or saga label. Commands carry `correlation_id` (the saga ID) and a W3C
`traceparent` in the body and Kafka headers: the start request's validated
context stored on the saga row, or one generated root per saga
(`trace_origin`); every participant result echoes it (ADR-0004, Saga). Alerts and runbooks:
`docs/runbooks/saga-alerts.rules.yml`. The static
`SAGA_TENANT_IDS` list is retired: the worker refuses to start when it is set.
Workers take leased shards instead (ADR-0013, migration `000005`). There are 64
shard lease rows; a worker renews up to `SAGA_MAX_SHARDS` of them every TTL/3
(`SAGA_LEASE_TTL_SECONDS`, default 15). Each takeover increases the shard's
fencing token. Command publication and deadline compensation check the lease with
`SELECT ... FOR SHARE` in the same tenant transaction, so a paused or expired
worker gets `ErrLeaseLost` and cannot publish or write once a newer token exists.
Tenants are enumerated per shard, 100 at a time, through the ID-only
`saga_shard_tenants` SECURITY DEFINER selector. It returns only tenants with
unpublished commands or in-flight sagas. All workers share the result consumer
group (`SAGA_RESULT_GROUP`, default `greenguard-saga-orchestrator-v1`).
Permanent invalid, stale or conflicting results are published to
`greenguard.saga.results.dlq.v1` with source coordinates and the raw record
before their source offsets commit. Database failures hold the offset.

Deadlines: a forward step (`reserving`, `configuring`, `activating`) that passes
its 15-minute deadline moves to `compensating` with a version bump. The
`asset.release` or `inventory.deactivate` command is committed before it is
published. A timed-out compensation becomes `repair_required` for an audited
operator replay or redrive (`POST /v1/provisioning/{id}/redrive`, admin role). A
late result for a superseded command version is recorded as
`late_result.reconciled`. It never advances the saga: the compensation queued
behind it on the same Kafka key undoes a late success.

The `greenguard_sagas` PostgreSQL database is owned by `saga_migrator`; the
`saga_app` runtime role has no table ownership or RLS bypass. All four saga
tables force tenant RLS. `saga.Store.Start` runs in one tenant transaction:
it claims the asset, creates a `reserving` saga, queues `asset.reserve`, and
records `provisioning.requested`. A repeated idempotency key returns the same
snapshot only when the device and asset match. The partial unique asset index
allows one active or repair-required claim per tenant and asset; two racing requests cannot both
win. Every transition locks the saga row and compares its version and fencing
token. The result receipt, state change, next command and audit row commit
together.

Local checks: `make saga-migrate` then `make saga-test` with `SAGA_DIRECT_URL`
from `make bootstrap`. The live tests prove one saga/command/audit transaction,
idempotent retry, changed-payload conflict, tenant and unscoped RLS denial, and
one winner for a concurrent asset claim. The result live test proves tenant
isolation, mismatched fencing token rejection, atomic advancement and replay without a
second configure command.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.

## Placement routing

`SHARD_REGISTRY_FILE` routes API commands, participant results, repairs, expirations and command publication to the current customer primary. Each physical shard has its own existing 64 scheduler leases; these are separate from the four placement shards. Workers admit explicit infrastructure before lease/ID scans and select the destination shard's lease fence after tenant routing. Each scan pass visits one bounded tenant page per held scheduler bucket. Count-only metrics aggregate all four or fail unavailable. Kafka IDs and command row locks retain replay identity. See [Go sharding contract](../../packages/go-common/SHARDING.md).
