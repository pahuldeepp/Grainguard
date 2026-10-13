# device-service HTTP API

Base path `/v1`. Every response is JSON; every error is `application/problem+json`. Health probes `/healthz` and `/readyz` are outside `/v1` and unauthenticated.

The API is mounted only when `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AUTH_JWKS_URL` are all set (a partial set fails startup). Without them the service exposes health probes only.

## Authentication and tenancy

`Authorization: Bearer <RS256 JWT>`. The token must carry `iss`, `aud`, `exp`, `sub`, `tenant_id` (lowercase UUID) and `roles` (any of `viewer`, `operator`, `admin`, `device`; `device` tokens are for the telemetry ingest service, where the subject is the device ID, and are not accepted by the inventory endpoints). The tenant is taken **only** from the signed `tenant_id` claim; a tenant header, query or body field is ignored. Keys come from the JWKS URL (cached; a rotated key is picked up after the cooldown). Real identity-provider setup is Stage 09.

| Role     | Allowed                                               |
| -------- | ----------------------------------------------------- |
| viewer   | `GET`                                                 |
| operator | viewer + register devices, change bindings and status |
| admin    | operator + create sites, bins and grain-lot placements |

## Versioning and sunset

Clients select a contract revision with the request header `API-Version: <version>`. Omitted means the registry default. The service always answers with `API-Version: <resolved>` and `Vary: API-Version`.

| Situation                       | Response                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported version               | normal response                                                                                                                                                                                                                         |
| Deprecated version              | normal response plus `Deprecation: @<unix seconds>` (RFC 9745), `Sunset: <HTTP-date>` (RFC 8594) when a sunset date is set, and `Link: <urn:api-version:N>; rel="successor-version"` / `Link: <url>; rel="deprecation"` when configured |
| Unknown or malformed version    | `400` `unsupported_api_version`, body lists the supported versions                                                                                                                                                                      |
| Version past its sunset instant | `410 Gone` `api_version_sunset` with the `Sunset` header, before authentication                                                                                                                                                         |

Policy comes from `API_VERSION_POLICY` (JSON, absent means only version `1`):

```json
{
  "defaultVersion": "2",
  "versions": [
    {
      "version": "1",
      "deprecatedAt": "2026-10-01T00:00:00Z",
      "sunsetAt": "2027-04-01T00:00:00Z",
      "successor": "2",
      "documentationUrl": "https://docs.example/migrate-v2"
    },
    { "version": "2" }
  ]
}
```

Invalid policy (bad JSON or dates, sunset before deprecation, unknown default or successor, duplicates) stops startup. See [ADR-0003](adr/0003-api-versioning.md).

## Endpoints

| Method and path                                     | Role     | Notes                                                                                                                                                                                                               |
| --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/sites` `{name}`                           | admin    | Requires `Idempotency-Key`; `201 {siteId, name, siteVersion, eventId}`                                                                                                                                              |
| `POST /v1/bins` `{siteId, name}`                    | admin    | Requires `Idempotency-Key`; `201 {binId, siteId, name, binVersion, eventId}`; the site must belong to the tenant, else `422`                                                                                        |
| `POST /v1/bins/{id}/lots` `{grainType, variety?, effectiveFrom}` | admin | Requires `Idempotency-Key`; `effectiveFrom` is exact UTC milliseconds such as `2026-09-20T08:00:00.000Z` and may be at most five minutes ahead of server time. Places one new lot, closes the previous interval, and returns `{binId, lotId, grainType, occupancyVersion, effectiveFrom, eventId}`. The next start must be later than the current start. |
| `GET /v1/bins/{id}/lots/at?observedAt=...` | viewer | Returns the batch occupying the bin at the requested UTC millisecond instant, or `{placement:null}`. At a replacement boundary, the new lot owns that instant. |
| `POST /v1/devices` `{serialNumber, siteId, binId?}` | operator | Requires `Idempotency-Key` (1-200 printable characters). `201` with `ETag: "1"` and `Location`. A retry with the same key returns the original result; the same key with another body is `409 idempotency_conflict` |
| `GET /v1/devices?limit&after`                       | viewer   | Keyset pages, `limit` 1-500 (default 50), `nextCursor` is the last device ID or `null`                                                                                                                              |
| `GET /v1/devices/{id}`                              | viewer   | `ETag` is the binding version; `If-None-Match` gives `304`                                                                                                                                                          |
| `PATCH /v1/devices/{id}` `{siteId, binId}`          | operator | Requires `If-Match: "<version>"`. Missing is `428`, stale is `412` with the current `ETag`                                                                                                                          |
| `POST /v1/devices/{id}/status` `{status}`           | operator | `active`, `disabled` or `deleted`; takes a row lock with a 2 s limit, busy is `409 resource_locked` with `Retry-After`                                                                                              |

Site, bin, grain-lot placement and device creation require an `Idempotency-Key` of 1–200 printable characters without spaces. Missing or malformed keys return `400 invalid_request`. A retry with the same tenant, command type, key and normalized body returns the original response and event ID without another row or event; a different body returns `409 idempotency_conflict`. Keys are scoped by tenant and command type.

## Errors

Body: `{type, title, status, code, detail?, correlation_id}`. Codes: `missing_token`, `malformed_header`, `invalid_token`, `expired_token`, `invalid_claims` (401), `insufficient_role` (403), `invalid_request` (400), `not_found` (404), `idempotency_conflict`, `duplicate_resource`, `resource_locked` (409), `version_conflict` (412), `precondition_required` (428), `invalid_reference` (422), `unsupported_api_version` (400), `api_version_sunset` (410), `auth_unavailable` (503, signing-key service unreachable or slow, with `Retry-After`; token faults stay 401), `http_error`, `internal_error` (500, no internal detail).

## Correlation

Send `X-Correlation-Id` (lowercase UUID) and `traceparent` (W3C, non-zero IDs) to keep them; malformed values are replaced; a `traceparent` keeps its trace and span IDs but only the sampled bit of its flags. The response echoes `X-Correlation-Id`, and both values are stored on the outbox events the request creates.

## Tracing

When `OTEL_EXPORTER_OTLP_ENDPOINT` is set (an OTLP/HTTP collector URL such as `http://collector:4318`), each `/v1` request runs in a server span that continues the caller's `traceparent`. The `traceparent` stored on any outbox event the request writes is that span's context, so later hops link to the request. `OTEL_TRACES_SAMPLE_RATIO` (0 to 1, default 1) sets the share of new traces recorded; a sampling decision made by the caller is kept. Spans carry `greenguard.tenant_id`. Without an endpoint, tracing is off and a valid caller `traceparent` is passed through as before. See [ADR-0004](adr/0004-tracing.md).

## Events

Registering, rebinding and status changes write `device.registered`, `device.binding_changed` and `device.status_changed` to the outbox. Their contracts are `contracts/events/device-*.v1.schema.json`; `@greenguard/contracts` validates them and the API tests validate every event the API writes.

Creating a site or bin writes `site.changed` or `bin.changed` respectively, with aggregate type `site` or `bin` and aggregate version `"1"`. The row, outbox event, audit record and command receipt commit in one transaction. Contracts are `contracts/events/site-changed.v1.schema.json` and `contracts/events/bin-changed.v1.schema.json`: payloads contain `site_id, name, site_version` and `bin_id, site_id, name, bin_version` respectively. Payload IDs and versions match the envelope; versions are decimal strings. Future edits use optimistic concurrency on the persisted `version` column.

The transformer routes both facility event types to `greenguard.inventory.facility.v1` (six partitions), keyed by `tenant_id:aggregate_id`. Device events retain `greenguard.inventory.device.v1`. Unknown event types are quarantined as `unknown_event_type`. Values are plain JSON with the six headers specified by [ADR-0010](adr/0010-schema-registry-contract.md); correlation, command causation and origin trace context are persisted with each event. Schema Registry is a CI compatibility/registration gate, not a runtime dependency.

Grain-lot placement writes `lot.changed` with aggregate type `bin_occupancy`, aggregate ID equal to the bin ID and a monotone occupancy version. Its payload identifies the new lot/grain, the replaced lot (if any), and the effective start. The transformer routes it to dedicated `greenguard.inventory.lot.v1`, so existing device, facility, telemetry and Cassandra consumers do not receive a new event type. The interval is `[effective_from, next effective_from)`; late sensor readings use the lot active at their observation time. Empty-bin retirement is a later command and event.

## Cable/sensor owner API

Cable inventory is owned by device-service (ADR-0027). All routes require a
human bearer principal; viewer/operator/admin can read, operator/admin can
create, edit and remove. Each cable is associated with an active provisioned
device and its current agricultural bin binding. Hardware `assetId` is a
separate identity and is rejected in cable bodies.

| Route | Behavior |
| --- | --- |
| `POST /v1/cables` | Body `{binId, deviceId, label, sensors}`; requires `Idempotency-Key`; returns 201, ETag and Location. Retrying retains assigned cable/sensor IDs. |
| `GET /v1/bins/{id}/cables?limit&after` | Current cables; keyset cursor is the last cable ID; at most 20 cables per page, including at most 100 sensors per cable. |
| `GET /v1/cables/{id}` | Current owner layout or removed tombstone, with ETag/cableVersion. Another tenant's ID returns 404. |
| `PATCH /v1/cables/{id}` | Complete replacement body; requires `If-Match`; existing `sensorId` retains identity, entries without IDs receive new IDs, omissions retire sensors. |
| `DELETE /v1/cables/{id}` | Requires `If-Match`; writes a removed tombstone and a versioned empty layout event. |

Sensors use `{sensorId?, position, label, depthM}`. IDs are allowed only on
edits and must already belong to the current cable. Positions are distinct
integers from 1 through 100. `depthM` is nullable finite nonnegative meters;
missing stays null, and zero is an actual depth. These cardinality/position
bounds limit API work, not agronomic or device operating ranges. A retired
sensor ID cannot be reassigned or revived.

Cable edits/removals require a quoted positive ETag. Missing `If-Match` is 428;
stale is 412 with the current ETag. Invalid references, including another
cable's/tenant's sensor, are 422. Every successful mutation commits state,
audit and `cable.layout_changed` v1 together. Device/import moves emit new
versions with the same stable sensor IDs; unbinding or deletion emits
`operation: deleted` with no sensors. Event snapshots retain prior layout
provenance for accepted observations.
