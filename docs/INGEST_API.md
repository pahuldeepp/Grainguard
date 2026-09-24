# telemetry-ingest HTTP API

Health probes `/healthz` and `/readyz` are unauthenticated. The ingest endpoint and `/metrics` are mounted only when `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AUTH_JWKS_URL` are all set (a partial set stops startup); without them the service serves only the probes. Errors are `application/problem+json` with `{type, title, status, code, detail?, correlation_id}`.

## POST /v1/devices/{deviceId}/readings

Stores one reading. `Authorization: Bearer <RS256 JWT>` is required. The tenant comes only from the signed `tenant_id` claim; no header, path or body field can choose it.

| Role                | May post                                                      |
| ------------------- | ------------------------------------------------------------- |
| `device`            | only its own device (the token subject must equal `deviceId`) |
| `operator`, `admin` | any device of their own tenant                                |
| `viewer`            | nothing                                                       |

Body (max 16 KiB, unknown fields rejected):

```json
{
  "source_message_id": "boot-018.reading-000042",
  "observed_at": "2026-09-21T14:59:59.500Z",
  "temperature_c": 28.75,
  "relative_humidity_percent": 66.2
}
```

`source_message_id` is created by the device before its first send and reused on every retry (1-128 characters: letters, digits, `.`, `_`, `:`, `-`, starting with a letter or digit). At least one measurement is required; a JSON `null` counts as absent, never as zero. `observed_at` is the device's measurement time; the server records its own arrival time separately.

**202** (a retry returns the same body): `{"status":"stored","reading_id":"...","event_id":"...","stream_version":"42","projection_status":"pending"}`. `projection_status` describes the moment of acknowledgement, not the current state of the read model.

The reading, its `telemetry.recorded` outbox event, an idempotency receipt and an audit row commit in one database transaction. A retry with the same `source_message_id` and the same values returns the original acknowledgement and changes nothing; the same ID with different values is `409 idempotency_conflict`.

## Order of checks and reasons

Authenticate, then rate limit, then parse and validate, then the transaction. Every refusal has a stable `code`, is counted in `ingest_rejections_total{reason}`, and never becomes a reading.

| Status | Code                                                                                                    | Meaning                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `missing_token`, `malformed_header`, `invalid_token`, `expired_token`, `invalid_claims`                 | authentication failed (`WWW-Authenticate: Bearer`)                                                                                 |
| 503    | `auth_unavailable`                                                                                      | the signing-key service is unreachable or slow (`Retry-After: 5`); token faults stay 401                                           |
| 429    | `rate_limited`                                                                                          | the device or tenant bucket is empty (`Retry-After` in seconds); nothing is written                                                |
| 400    | `invalid_body`, `invalid_field`                                                                         | not a JSON object, too large, unknown field, or a bad identifier or timestamp                                                      |
| 422    | `no_measurements`, `non_finite_value`, `value_out_of_range`, `timestamp_in_future`, `timestamp_too_old` | data quality (temperature -80 to 120 C, humidity 0 to 100 percent; no more than 5 minutes ahead; no older than 7 days)             |
| 403    | `device_forbidden`, `device_disabled`                                                                   | a token that may not write this device, or an inactive binding                                                                     |
| 409    | `device_not_ready`, `idempotency_conflict`                                                              | no local binding yet (or a device of another tenant, which looks identical), or a reused `source_message_id` with different values |
| 500    | `internal_error`                                                                                        | no internal detail is returned                                                                                                     |

## Rate limiting

Token buckets per device and per tenant ([ADR-0007](adr/0007-ingest-rate-limiting.md)). Defaults: device 0.2 tokens per second with a burst of 20, tenant 200 per second with a burst of 2000. A device token spends its own bucket even if the path names another device.

## GET /metrics

Prometheus text: `ingest_rejections_total{reason}` (bounded label set) and `ingest_readings_accepted_total`. It is unauthenticated, so expose it only on an internal network.

## Configuration

| Variable                                                                                 | Default            | Purpose                                                        |
| ---------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| `TELEMETRY_DATABASE_URL`                                                                 | required           | runtime connection through PgBouncer                           |
| `HTTP_ADDR`                                                                              | `127.0.0.1:8080`   | listen address                                                 |
| `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL`                                          | unset              | enable the endpoint (all three, https or loopback http)        |
| `INGEST_DEVICE_RATE`, `INGEST_DEVICE_BURST`, `INGEST_TENANT_RATE`, `INGEST_TENANT_BURST` | 0.2, 20, 200, 2000 | rate limits                                                    |
| `INGEST_MAX_AGE`, `INGEST_MAX_FUTURE_SKEW`                                               | `168h`, `5m`       | timestamp limits                                               |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLE_RATIO`                                | unset, `1`         | tracing; the stored `traceparent` is the request's server span |

Design records: [ADR-0005](adr/0005-device-binding-consumer.md), [ADR-0006](adr/0006-ingest-quality-and-lateness.md), [ADR-0007](adr/0007-ingest-rate-limiting.md).
