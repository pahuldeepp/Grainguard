# device-service HTTP API

Base path `/v1`. Every response is JSON; every error is `application/problem+json`. Health probes `/healthz` and `/readyz` are outside `/v1` and unauthenticated.

The API is mounted only when `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AUTH_JWKS_URL` are all set (a partial set fails startup). Without them the service exposes health probes only.

## Authentication and tenancy

`Authorization: Bearer <RS256 JWT>`. The token must carry `iss`, `aud`, `exp`, `sub`, `tenant_id` (lowercase UUID) and `roles` (any of `viewer`, `operator`, `admin`). The tenant is taken **only** from the signed `tenant_id` claim; a tenant header, query or body field is ignored. Keys come from the JWKS URL (cached; a rotated key is picked up after the cooldown). Real identity-provider setup is Stage 09.

| Role     | Allowed                                               |
| -------- | ----------------------------------------------------- |
| viewer   | `GET`                                                 |
| operator | viewer + register devices, change bindings and status |
| admin    | operator + create sites and bins                      |

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
| `POST /v1/sites` `{name}`                           | admin    | `201 {siteId, name}`                                                                                                                                                                                                |
| `POST /v1/bins` `{siteId, name}`                    | admin    | `201`; the site must belong to the tenant, else `422`                                                                                                                                                               |
| `POST /v1/devices` `{serialNumber, siteId, binId?}` | operator | Requires `Idempotency-Key` (1-200 printable characters). `201` with `ETag: "1"` and `Location`. A retry with the same key returns the original result; the same key with another body is `409 idempotency_conflict` |
| `GET /v1/devices?limit&after`                       | viewer   | Keyset pages, `limit` 1-500 (default 50), `nextCursor` is the last device ID or `null`                                                                                                                              |
| `GET /v1/devices/{id}`                              | viewer   | `ETag` is the binding version; `If-None-Match` gives `304`                                                                                                                                                          |
| `PATCH /v1/devices/{id}` `{siteId, binId}`          | operator | Requires `If-Match: "<version>"`. Missing is `428`, stale is `412` with the current `ETag`                                                                                                                          |
| `POST /v1/devices/{id}/status` `{status}`           | operator | `active`, `disabled` or `deleted`; takes a row lock with a 2 s limit, busy is `409 resource_locked` with `Retry-After`                                                                                              |

## Errors

Body: `{type, title, status, code, detail?, correlation_id}`. Codes: `missing_token`, `malformed_header`, `invalid_token`, `expired_token`, `invalid_claims` (401), `insufficient_role` (403), `invalid_request` (400), `not_found` (404), `idempotency_conflict`, `duplicate_resource`, `resource_locked` (409), `version_conflict` (412), `precondition_required` (428), `invalid_reference` (422), `unsupported_api_version` (400), `api_version_sunset` (410), `auth_unavailable` (503, signing-key service unreachable or slow, with `Retry-After`; token faults stay 401), `http_error`, `internal_error` (500, no internal detail).

## Correlation

Send `X-Correlation-Id` (lowercase UUID) and `traceparent` (W3C, non-zero IDs) to keep them; malformed values are replaced; a `traceparent` keeps its trace and span IDs but only the sampled bit of its flags. The response echoes `X-Correlation-Id`, and both values are stored on the outbox events the request creates.

## Events

Registering, rebinding and status changes write `device.registered`, `device.binding_changed` and `device.status_changed` to the outbox. Their contracts are `contracts/events/device-*.v1.schema.json`; `@greenguard/contracts` validates them and the API tests validate every event the API writes.
