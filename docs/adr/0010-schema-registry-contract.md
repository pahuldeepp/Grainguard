# ADR-0010: deployment-wide Schema Registry contract

Status: **Accepted — 2026-09-24**.

Owner: Stage 04 event infrastructure and contracts; Stage 05 consumers adopt this
contract. This ADR records the approved deployment-wide decision;
it does not claim registration, CI gates or consumer changes are implemented.

## Context

[FIRST_VERTICAL_SLICE](../FIRST_VERTICAL_SLICE.md) lines 105 and 107 require
Registry identity headers and startup registration checks. [ADR-0008](0008-canonical-transformer.md)
instead implements local JSON Schema validation, plain JSON and six headers, with
no Registry client in the transformer. Registry is deployed, but schemas are not
registered by the current infrastructure. A service-local exception is insufficient
for Stage 05 consumers to choose a compatible codec.

## Decision and Stage 05 contract

JSON Schema files in `contracts/events/` are the source of truth. Canonical topic
values are UTF-8 plain JSON, with **no Registry wire-format prefix**. The required
headers are `event_id`, `event_type`, `schema_version`, `tenant_id`, `correlation_id`
and `traceparent`, encoded as UTF-8 text and consistent with the canonical envelope.
Use the ADR-0008 key `tenant_id:aggregate_id` deployment-wide; preserve per-aggregate
ordering. Event identity and tenant identity never come from an untrusted header
without checking the validated envelope.

Registry is a deployment/CI compatibility-check and registration gate, **not part
of the runtime hot path or a startup network dependency**. Register schema type
`JSON` (JSON Schema), subject strategy `<topic>-value`, compatibility `BACKWARD`.
For example: `greenguard.telemetry.recorded.v1-value`. A registration script and CI
wiring are planned Stage 04 follow-ups before deploying Stage 05 consumers. They
must check compatibility, register the exact reviewed contract, and retain a
release manifest mapping topic, subject, Registry version/ID, repository commit
and file SHA-256. Resolve local references reproducibly; check fixtures with the
pinned production validators. For topics carrying multiple event types, register
an explicit topic value union of the allowed repository event schemas and test
every variant; do not register unrelated schemas successively under one subject.

Runtime startup compiles the release's local schemas with real UUID/date-time
format assertions and semantic cross-field validation. It does not resolve schema
IDs or contact Registry. A Registry outage blocks a new release's registration
gate, not already-approved event processing. No `schema_id`, `schema_subject` or
Registry lookup is required in Kafka headers. `content-type=application/json` may
be informational but is not a required discriminator.

Optional header `schema_checksum`: lowercase hex SHA-256 of the exact packaged
schema file bytes identified in the release manifest (including its pinned reference
closure there). It is diagnostic, not a signature, authorization check or replacement
for schema validation. Absence is valid; an unknown/mismatched value is a contract
mismatch to quarantine when checksum enforcement is enabled. Producers must not
claim this optional header is already emitted by current code.

Stage 05 consumers must dispatch by approved event type/version, validate against
packaged schemas and semantic rules, check key/header/envelope agreement and apply
tenant filtering plus atomic inbox/effects. Enforce telemetry aggregate/device
identity equality as tracked in review H5; neither current validator proves it yet.
Unknown versions or invalid values fail closed into confirmed quarantine with
source coordinates; never acknowledge a skipped effect. Commit offsets only after
the effect or quarantine is durable. Retain old validators/adapters for replay;
Registry availability is not needed to decode historical records.

## Evolution and rollout consequences

`BACKWARD` tests new-reader/old-writer compatibility; it does not prove old readers
accept new writes. Existing strict `additionalProperties: false` schemas mean even
an added field can break an older consumer. Changing a schema without the gate can
cause validation failures, quarantine, lag and missing projections. A version-header
bump cannot repair an incompatible payload or reinterpret old records.

Roll out consumer-first: review a new immutable contract/topic version and fixture
matrix; pass compatibility and semantic tests and register it; deploy consumers
that accept both retained and new versions; only then enable producers; drain/replay
and reconcile before retiring old consumers/topics. Version new incompatible topics
and subjects explicitly, preserving outbox atomicity and consumer dedupe during any
migration. Keep existing versions immutable; no in-place schema replacement. Test
older retained versions as well as the immediate predecessor because `BACKWARD`
alone is not transitive. Registration failure blocks release rather than silently
changing the runtime contract.

## Rejected alternative

Avro, Protobuf or JSON-Schema Registry wire format with Registry-aware runtime
serializers/deserializers (including startup ID resolution) would provide standard
schema-ID framing. It would also require a coordinated producer/consumer codec
migration, client dependencies and runtime/startup Registry failure handling. Plain
JSON already matches ADR-0008 and local replay tooling. A future framed codec needs
a separate ADR and an explicit migration boundary; consumers must not guess between
framed and unframed bytes.

## Applied design-sketch amendments

Line numbers refer to the FIRST_VERTICAL_SLICE.md reviewed for this ADR. These
amendments were applied on 2026-09-24:

- Line 99: replace inventory key `tenant_id:device:device_id` with
  `tenant_id:aggregate_id` (device ID is that aggregate ID).
- Line 100: replace telemetry key `tenant_id:device_telemetry_stream:device_id`
  with `tenant_id:aggregate_id` (device ID is that aggregate ID).
- Line 105: retain UTF-8 plain JSON/no binary framing; replace required
  `schema_subject`, `schema_id`, `content-type` and subject-ID consumer lookup with
  the six required headers above and optional checksum. Move the registration
  mapping requirement to the CI/release gate and use `<topic>-value` subjects.
- Line 107: replace Registry registration-dependent transformer readiness with
  local-schema compilation/readiness. Require CI compatibility/registration and
  old/new fixture tests; quarantine unknown event types/versions using packaged
  schemas, not Registry IDs. State that approved runtime processing survives a
  Registry outage.

This accepted deployment-wide contract supersedes those clauses and extends
ADR-0008's service-local codec decision to all canonical producers and consumers.
