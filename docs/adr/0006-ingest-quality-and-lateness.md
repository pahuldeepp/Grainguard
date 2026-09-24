# ADR-0006: ingest data quality, rejection handling and lateness

Status: accepted, 2026-09-24 (Stage 03b).

## Data quality at the ingest boundary

A reading is checked in this order before any transaction starts, and the first failure wins: first the device ID in the path must be a lowercase UUID (`invalid_field`) and the caller must be allowed to write that device (`device_forbidden`); then the body checks below run in order. Each failure has one stable reason code and HTTP status that is returned to the device:

| Reason                 | Status | Meaning                                                                                                     |
| ---------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `invalid_body`         | 400    | not a JSON object, larger than 16 KiB, or an unknown field                                                  |
| `invalid_field`        | 400    | bad `source_message_id`, `observed_at`, device ID or measurement type                                       |
| `no_measurements`      | 422    | neither temperature nor humidity present (null counts as absent, never zero)                                |
| `non_finite_value`     | 422    | a number that overflows to infinity                                                                         |
| `value_out_of_range`   | 422    | temperature outside -80 to 120 C, humidity outside 0 to 100 percent (input limits, not spoilage thresholds) |
| `timestamp_in_future`  | 422    | `observed_at` more than 5 minutes after arrival                                                             |
| `timestamp_too_old`    | 422    | `observed_at` older than the maximum age (7 days by default)                                                |
| `device_forbidden`     | 403    | a device token for another device, or a role that may not ingest                                            |
| `device_not_ready`     | 409    | no local binding yet (the inventory event has not arrived)                                                  |
| `device_disabled`      | 403    | the binding is not active                                                                                   |
| `idempotency_conflict` | 409    | same `source_message_id` with different measurements                                                        |

The tenant comes only from the verified token. A device in another tenant is indistinguishable from an unbound device (`device_not_ready`), because row-level security hides it.

## Rejections

A rejected reading is never stored as a reading and never lost silently: the device gets the reason and decides whether to retry or drop it. Rejections are counted per reason (`ingest_rejections_total{reason}`; tenant and device go on logs and traces, never on metric labels). A bounded sample keeps evidence for debugging, and only for devices that have a binding (an unbound device ID is caller-chosen, so it is counted and never sampled): `ingest_rejection_samples` holds at most 20 rows per device by construction (a random-slot upsert), stores a payload hash and never the payload, and is written at most once per device per 10 seconds. Bad input can therefore not grow storage or force one write per request. Audit rows remain for accepted changes only.

## Lateness

Event time (`observed_at`) and arrival time (`received_at`) are separate. Late readings are always stored: history keeps every accepted reading and "latest" is chosen by `(observed_at, stream_version)`.

- Up to the **maximum age** (default 7 days, configurable) a late reading is accepted like any other.
- Beyond it the reading is rejected as `timestamp_too_old`; a device that buffered data for longer must use a backfill path (a later stage), not the live endpoint.
- **Allowed lateness for windows** is a rollup concern, not an ingest one. When Stage 05 builds rollups, a window closes when the device's watermark passes its end plus the allowed lateness (initial value 10 minutes); a reading that arrives after the window closed still lands in history and triggers a recompute of that window, and recomputation must equal incremental results.
- There is no streaming-engine watermark. `max_seen_stream_version` and gap tracking say "no known gap", never "everything has arrived".

## Consequences

Every rejection class has a test, a counter and a stable code. The maximum age and future-skew limits are configuration (`INGEST_MAX_AGE`, `INGEST_MAX_FUTURE_SKEW`). Per-device-class lateness values and the backfill path are deferred.
