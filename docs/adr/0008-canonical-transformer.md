# ADR-0008: deterministic canonical CDC transformer

Status: implemented locally, pending live integration evidence.

The transformer follows FIRST_VERTICAL_SLICE section 5B and ADR-0005's inbox
identity rules. Scope is raw outbox transport, not device binding consumption,
CDC role grants, registry provisioning, or milestone completion.

## Decisions

- **Libraries:** Go 1.27.1, `github.com/twmb/franz-go v1.22.0` and
  `github.com/santhosh-tekuri/jsonschema/v6 v6.0.3`. franz-go supplies default
  idempotent production, explicit all-ISR acknowledgements, synchronous delivery,
  manual offset commit and rebalance blocking. Test-only kfake is pinned at
  `v0.0.0-20260923172636-a5c3af0cdb3d`, with kmsg `v1.14.0`. The requested initial
  franz-go v1.20.7 was incompatible with the cached kfake; v1.22.0 is the approved
  replacement. There are no local library forks or version replacement directives.
- **Validation:** compile the same six repository schemas (device, facility and telemetry) at startup from
  `EVENT_SCHEMA_DIR`, included unchanged in the container. Enable Draft 2020-12
  format assertions. Apply the TypeScript validator's nil UUID, signed-bigint,
  nonzero trace/parent and device aggregate consistency checks. Unknown routing
  keys fail closed. Fixture verdicts are checked in alongside shared fixtures.
- **Mapping:** snake_case outbox columns only; tenant always comes from the row.
  `payload` supports object/string JSONB representations. `occurred_at` supports
  ISO strings and integer microsecond epochs, serialized to six UTC fractional
  digits. Epoch units are explicit, never inferred from magnitude. Discard only
  storage metadata such as `created_at`. Preserve event ID and origin trace.
- **Keys/headers:** this task explicitly chooses `tenant_id:aggregate_id` and the
  six headers `event_id`, `event_type`, `schema_version`, `tenant_id`,
  `correlation_id`, `traceparent`. This supersedes the older design sketch's
  aggregate-type segment and schema registry headers **for this service**. Values
  use plain canonical JSON without Confluent framing. Registry registration
  remains infrastructure-owned; startup verifies local files, not registration.
  Consumer wiring must align with this contract before deployment.
- **Commit frontier/concurrency:** one outstanding record across all assigned
  partitions. Poll with auto-commit disabled and rebalances blocked; publish
  synchronously with `acks=all`, then commit that record. This establishes a
  contiguous per-partition frontier without a completion map or batch timer.
  Ignore `u`, `d` and tombstones explicitly. Release rebalances before the next
  poll and on close. A 20-second processing deadline is below the 60-second
  rebalance timeout; exhausting retry time closes the worker without advancing
  its offset. Retry commit errors without republishing. Restart is required for
  recovery after deadline/fetch failure. Scaling across partitions is deferred.
- **Quarantine:** stable reasons are `bad_envelope`, `unsupported_op`,
  `missing_field`, `schema_invalid`, `unknown_event_type`, `bad_timestamp`,
  `bad_bigint`. Preserve source topic/partition/offset and error detail. Base64
  preserves arbitrary raw bytes, limited to 64 KiB with a truncation flag. Never
  commit poison input until quarantine delivery is acknowledged. Details are
  bounded fixed strings; no per-tenant/device metric labels or raw-body logs.
- **Idempotency by construction:** deterministic encoding and stable IDs make
  identical raw deliveries byte-identical. Broker idempotence handles producer
  retries within a session; it cannot close the publish/offset-commit crash
  window. Delivery is at least once and downstream inboxes remain mandatory.
- **Observability:** health/readiness/metrics follow telemetry-ingest conventions.
  Commit lag is the number of fetched uncommitted messages, not fleet backlog.
  Optional OTLP tracing uses the same SDK/exporter versions and W3C propagation,
  with a fresh producer span per attempt continuing the stored origin. No origin
  rewriting occurs. No global tracer provider mutation is necessary.

## Verification limits and review

Unit/golden/parity/retry/lifecycle tests include the actual Kafka adapter through
kfake's in-memory protocol network. They do not establish live Kafka quorum
acknowledgements, registry registration, Debezium snapshot/WAL correctness,
source transaction rollback, rebalance fencing under outages, or end-to-end
E01–E05. Schema Registry readiness, secure broker transport, independent partition
workers, binding-feed freshness (review R7), and live recovery evidence remain
separate work. CDC RLS exemption (review R1) is infrastructure-owned. No database
or tenant SQL paths are introduced by this service.

The shared technology catalog already declares Go/Kafka/JSON Schema/OpenTelemetry;
no catalog edit is included because this task only authorizes service/build wiring
and this ADR. Review the plain JSON header convention, supervisor restart policy,
64 KiB quarantine cap and intentionally sequential throughput before deployment.

## Quarantine tenant handling

The shared quarantine topic is cross-tenant operational data and requires
restricted operational ACLs, not tenant-facing consumer access. Its key remains
the source topic/partition/offset. The transformer adds a `tenant_id` header only
from the raw outbox row after matching the lowercase UUID pattern in the event
schema; missing or invalid values become the fixed string `unknown`. This is a
best-effort purge hint, not authenticated authorization context. Per-tenant purge
selects records by that header; `unknown` records require separate restricted
retention handling. Tenant values never appear in metric labels or logs.
