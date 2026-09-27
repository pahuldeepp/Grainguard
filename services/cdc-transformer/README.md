# Canonical CDC transformer

Go service for Stages 04, 06 and 09. Reads the inventory, control-plane, billing, telemetry, risk and alert outbox CDC topics,
validates against the repository's immutable JSON Schema contracts, and publishes
canonical JSON or a bounded quarantine record. It never accesses a tenant database
or invents event identity. No milestone completion or live deployment is claimed.

## Run and configuration

From this directory: `go run .` after setting `KAFKA_BROKERS`.
From the repository root, build the image with this directory's Dockerfile and the
repository root as build context. The image includes the exact shared schemas and
runs as UID/GID 65532.

| Variable | Default / meaning |
| --- | --- |
| `KAFKA_BROKERS` | Required, comma-separated Kafka bootstrap addresses |
| `KAFKA_GROUP_ID` | `greenguard-cdc-transformer-v1`; keep stable across restarts |
| `EVENT_SCHEMA_DIR` | `../../contracts/events` relative to working directory; `/contracts/events` in the image |
| `HTTP_ADDR` | `127.0.0.1:8081`; `0.0.0.0:8081` in the image |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Optional OTLP/HTTP base URL; unset means no export |

Local plaintext Kafka is supported. Deployment with broker authentication/TLS
requires a reviewed configuration extension. Schemas compile at startup with
Draft 2020-12 and UUID/date-time format assertions. Missing/invalid schema files
prevent startup. Schema Registry registration and live connector tests belong to
the infrastructure slice; this process uses the approved files, not per-event
registry calls. See [ADR-0008](../../docs/adr/0008-canonical-transformer.md) for the
explicit key/header choices overriding the older design sketch.

## Mapping and routing

Input topics are `greenguard.raw.inventory.outbox`, `greenguard.raw.control.outbox`,
`greenguard.raw.telemetry.outbox`, `greenguard.raw.risk.outbox`,
`greenguard.raw.alerts.outbox`, and `greenguard.raw.projection.notifications`.
Each event type is accepted only from its owning source topic. Control-plane
`tenant.created`, `membership.changed` and `service_principal.*` route to
`greenguard.inventory.tenant.v1`. Risk assessments route to
`greenguard.risk.assessment.v1`, invalidation to
`greenguard.risk.assessment_invalidated.v1`, alert lifecycle events to
`greenguard.alerts.lifecycle.v1`, and `projection.notification` to
`greenguard.projection.notification.v1`. Accept both the direct JSON envelope emitted by
`schemas.enable=false` and an envelope under `payload`. Require
`source.table=outbox_events` for inserts/snapshots; metadata cannot supply tenant ID.
The topic's domain must match the validated event type.

`c` and `r` map `after`'s snake_case outbox columns directly. `created_at` is storage
metadata and is omitted. JSONB `payload` may be an object or JSON string. Bigint
versions are parsed losslessly as positive signed int64 and emitted as decimal
strings. No conversion through floating point is used. `occurred_at` accepts ISO
8601 (including offsets, normalized to UTC) or an integer **microsecond** Unix epoch;
numeric milliseconds are never guessed. Canonical output uses exactly six
fractional digits. PostgreSQL `timestamptz` normally uses Debezium ZonedTimestamp
strings; microseconds defensively support MicroTimestamp configurations. Precision
finer than microseconds is rejected. Payload timestamps stay as stored and are
validated by the shared schema.

| Event | Output topic |
| --- | --- |
| `site.changed@1`, `bin.changed@1` | `greenguard.inventory.facility.v1` |
| `lot.changed@1` | `greenguard.inventory.lot.v1` |
| `telemetry.recorded@1` | `greenguard.telemetry.recorded.v1` |
| `device.registered@1`, `device.binding_changed@1`, `device.status_changed@1` | `greenguard.inventory.device.v1` |
| `subscription.changed@1`, `entitlements.changed@1`, `usage.accepted@1`, `billing.reconciliation_required@1`, `billing.command_requested@1` | `greenguard.billing.lifecycle.v1` |
| `flag.configuration_changed@1` | `greenguard.platform.config.v1` |

Ordinary domain-event keys are exactly `tenant_id:aggregate_id`. Their headers are `event_id`, `event_type`,
`schema_version`, `tenant_id`, `correlation_id`, `traceparent`. Values are ordinary
UTF-8 JSON, without Confluent framing. Tenant comes exclusively from the row and
must be a non-nil lowercase UUID. The Go validator matches the TypeScript
validator's structural and semantic rules, including bigint bounds, device
and facility identity/version agreement, and nonzero trace/parent IDs.

Debezium inventory logical messages with `op=m`, the configured binding-feed
prefix, a valid source LSN/transaction/time and raw inventory partition 0
produce `binding.feed_checkpoint` records to all six partitions of
`greenguard.inventory.device.v1`. Those internal records use the fixed key
`binding-feed-checkpoint` and only the `binding_partition` header, which selects
their destination partition. They are not domain outbox events.
Routing uses an explicit event-type allowlist; unknown types are quarantined as
`unknown_event_type` and never default to the device topic.

Updates (`u`), deletes (`d`), and tombstones are logged, counted and committed
without emission. Unknown operations are quarantined. Append-only violations
should alert on the update counter.

## Delivery, quarantine and operations

One worker fetches one record at a time across its assigned partitions. This
intentionally trades cross-partition throughput for an obvious contiguous commit
frontier. Production uses franz-go idempotent production, `acks=all`, zero linger
and synchronous delivery. Offset commit occurs only after a confirmed canonical
or quarantine publication. Ignore-only operations commit after classification.
No partial batch waits for new traffic.

Publish and commit failures retry every second with readiness false. A message has
a 20-second processing budget (15-second producer delivery timeout, 60-second
rebalance timeout). Exhaustion stops the worker and process, leaving the offset
uncommitted; the supervisor must restart it. Rebalances are blocked only while the
polled record is processed and released before the next poll or close. Commit
failures retry the commit without publishing again. Crashes between broker ack and
commit can duplicate delivery: **at least once**, not exactly once. Sorted JSON
keys, preserved numbers/IDs and deterministic timestamps yield identical bytes for
the same input. Downstream consumers still need the inbox in ADR-0005.

Invalid records go to `greenguard.quarantine.v1`, keyed by source coordinates.
Body and headers include `reason`, `source_topic`, `source_partition`,
`source_offset`, `detail`, and `truncated`. Body `raw_base64` encodes up to 65,536
original bytes (including invalid UTF-8) losslessly; larger inputs set
`truncated=true`. Details use fixed text and do not echo unbounded input. A poison
record never prevents later messages after quarantine acknowledgement; quarantine
outages deliberately retain the partition offset.

| Reason | Meaning |
| --- | --- |
| `bad_envelope` | Invalid JSON/shape/source table/topic or source-domain mismatch |
| `unsupported_op` | Unknown Debezium operation |
| `missing_field` | Absent/null required outbox column |
| `schema_invalid` | Payload/schema/UUID/trace/cross-field violation |
| `unknown_event_type` | Unsupported `event_type@schema_version` |
| `bad_timestamp` | Invalid row timestamp or unsupported precision/range |
| `bad_bigint` | Invalid row version or schema-valid version exceeding int64 |

`GET /healthz` is liveness; `GET /readyz` checks broker ping and retry state with a
one-second deadline. `GET /metrics` serves consumed/published/quarantined/ignored
counters with only fixed reason/operation labels. `cdc_commit_lag` measures fetched
records awaiting offset acknowledgement (0 or 1), **not** broker backlog across
all partitions. Monitor consumer-group lag separately. Shutdown cancels pending
work, drains the HTTP server, closes Kafka and flushes tracing with bounded time.

Tracing follows telemetry-ingest's pinned OpenTelemetry/OTLP libraries and
parent-based 10% root sampling. Each publication attempt continues the stored W3C
origin as a fresh producer span; the record's origin header is never rewritten.
Quarantine without valid context starts a new root span. No tenant/device metric
labels are emitted.

## Tests

Run `go test -race -cover ./...` and `go vet ./...` here. No database is needed.
Shared `tests/fixtures/events/expectations.json` records existing TypeScript fixture
verdicts; `raw/expectations.json` records raw-envelope verdicts and golden outputs.
The suite covers mapping, parity, tenant provenance, retry/commit ordering,
poison recovery, duplicate identity, trace propagation, HTTP lifecycle, and a real
franz-go client talking to kfake over in-memory network connections.

These are deterministic in-process tests, not live Kafka, Schema Registry,
Debezium, database rollback, real rebalances, replicated broker durability, or
E01–E05 deployment evidence. Go's coverage report measures statements, not branch
coverage; branch cases are tested explicitly but no separate branch instrumenter
is included. Sonar's actual quality gate must still run in CI.
