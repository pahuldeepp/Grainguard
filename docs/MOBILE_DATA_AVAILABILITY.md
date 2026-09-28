# Mobile/web alert workflow: what the backend already exposes

Verified 2026-09-26 by source reading and a live probe as `alice@greenguard.test` (see
[live evidence](../evidence/MOBILE_DATA_AVAILABILITY_LIVE.md)). Nothing was changed. **Live caveat: the Read API
(127.0.0.1:4401) was not running, so every reading/device row is source-derived, not live-verified.**

Alert operations are persisted-only (`services/bff/src/query-policy.ts`). The GraphQL schema (`schema.ts`)
already has `openWindowStart` and `resolvedAt` on `AlertView`, but no persisted operation selects them.

| # | Data item | Exposed? | Operation / field path | Notes and smallest change if not |
| --- | --- | --- | --- | --- |
| 1 | Alert id | YES | `alertList.alerts.items[].alertId`, `alertDetail.alert.alertId` | Live OK. |
| 2 | Severity | YES | `.severity` (`warning`/`critical`) | Live: all `critical`. |
| 3 | State | YES | `.state` (`open`/`acknowledged`/`resolved`) | Live OK. |
| 4 | Score | YES | `.score` (0-100 number) | Live: 87. |
| 5 | Rule id | YES | `.ruleId` (uuid) | Live OK. |
| 6 | Rule name/key | NO | none | `alert_rules.rule_key` exists in workflow-alerts DB (`store.ts` already reads it). Add `ruleKey` to `AlertView` (`schema.ts`, `alerts/parse.ts` `toAlertDto`, `store.ts` join) and to both operations. Same tenant RLS path, no new exposure. |
| 7 | Escalation level | YES | `.escalationLevel` (int) | Live: 0. |
| 8 | Escalation timestamp | NO | none | `alert_episodes.escalated_at` not in DTO. Add `escalatedAt` to `toAlertDto`, schema, persisted ops. |
| 9 | Opened / acknowledged times | YES | `.openedAt`, `.acknowledgedAt` (ISO) | Live OK. |
| 10 | Resolved time | PARTIAL | `resolvedAt` in schema and REST DTO; not selected by any persisted op | Add `resolvedAt` (and `openWindowStart`) to `alertList`/`alertDetail` strings in `query-policy.ts` and mobile `alerts-client.ts`. No backend logic change. Live: resolved list is empty. |
| 11 | Acknowledged-by | PARTIAL | `alertDetail.alert.acknowledgedBy` (detail only; not in list op) | Value is the opaque Dex subject, not a display name. Name needs a tenant-scoped membership lookup (none exposed). |
| 12 | Bin id | YES | `.binId` | Live: 11 distinct bins. |
| 13 | Bin name | NO | none | Names live in device-service `bins.name` only. The read DB (`read.device_views`) stores ids and serial only. Smallest fix: add a bin/site name projection (new `read.bin_views`/`site_views` fed by facility events, see review H6: site/bin creation emits no events yet) or a `GET /v1/bins/:id` on device-service exposed through a new BFF field. Tenant RLS on `bins` already forced. |
| 14 | Site id / name | PARTIAL (id only, via device) | `device.siteId`, `siteDevices`; alert has no site | Alert row has no site. Id reachable only via a device on that bin, and only if Read API is up. Name: NO, same fix as 13. |
| 15 | Grain type | NO | none | `risk_assessments.grain_type` exists in risk-engine DB, not exposed. Add to a risk read query or the alert DTO via the risk outbox event/projection. |
| 16 | Temperature / humidity, latest | PARTIAL | `deviceCurrent.latestReading { temperatureC relativeHumidityPercent observedAt }` | Keyed by **deviceId**, not binId. Needs bin -> device: only `searchDevices` (text) / `siteDevices(siteId)` exist; no `devicesByBin`. Not live-verified (Read API down). Add `binDevices(binId)` to read-api (`app.ts`), `packages/read-model`, BFF. |
| 17 | CO2 | NO | none | Nowhere in schema, ingest contract or read tables. Only temperature C and relative humidity. Needs a contract change from ingest onward. |
| 18 | History / trend | PARTIAL | `deviceHistory.readingHistory[]`, `readingRollups[] {bucketStart sampleCount avgTemperatureC avgRelativeHumidityPercent}` | Per device, not per bin. Read API backend (Cassandra/Elasticsearch/read DB) may be down; not live-verified. |
| 19 | Thresholds / limits | NO | none | `alert_rules.open_score/clear_score` exist (score thresholds, not temperature limits), not exposed. Add with `ruleKey` (item 6). Per-grain temp/moisture limits are in risk-engine policy, not exposed. |
| 20 | Sensor / cable positions, per-sensor readings | NO | none | No cable/sensor model in any migration. Only one reading per device. |
| 21 | Device info | PARTIAL | `device`/`siteDevices`/`searchDevices`: `deviceId siteId binId name status projectedAt` | Read API dependent; no serial in GraphQL type. |
| 22 | Alert transitions (`alert_transitions`) | NO | none | Table in `greenguard_alerts` (type, from/to state, actor_type/actor_id, occurred_at). `/v1/alerts/:id/transitions` returned 404 live. Add `GET /v1/alerts/:id/transitions` in `alerts.controller.ts` (+ `store.ts` query under `withTenant`, RLS) and a BFF `alertTransitions` op. |
| 23 | Acknowledgement history | NO (derivable) | only the final `acknowledgedAt/By` | Full history = item 22 rows where `transition_type='acknowledged'`. |
| 24 | Escalation history | NO (derivable) | `escalationLevel` current only | Item 22 rows `escalated` / `escalation_suppressed`. |
| 25 | Delivered-notification log | NO | none | `notification_intents` (jobs-worker DB: transition, channel, status, attempts, dispatched_at) has no API. Add a tenant-scoped read route in jobs-worker, filtered by `alert_id`; must apply RLS/`tenant_id`, and hide `last_error` internals. |
| 26 | Pagination | YES | `limit` 1-100, `after` (alert-id cursor), `nextCursor` | Live: 11 rows, `nextCursor:null`. Order: dashboard says open first by severity then age. |
| 27 | Filters | PARTIAL | `state`: `open`/`acknowledged`/`resolved` | No severity, bin or rule filter. |
| 28 | Counts | NO | none | No count field. Dashboard counts by fetching a `limit` page per state (`AlertsView.tsx` `count` query). Mobile can do the same, capped at 100. |
| 29 | Acknowledge | YES | `acknowledgeAlert(id, version, idempotencyKey)` -> `{episodeId state version eventId}` | Roles operator/admin; `version` is the string from the list. |
| 30 | Live updates | PARTIAL | `subscription deviceChanged(deviceId)` -> `{deviceId readingId projectedAt streamVersion}` | Readings per device only. No alert subscription; poll `alertList`. |

## Bin and site names for the bare-UUID alerts

**No.** An alert carries only `monitored_resource_id` = `binId`. Bin and site names exist only in the
device-service `bins`/`sites` tables. No existing BFF/Read API query returns them. `device.binId`/`siteId` are ids too,
and `searchDevices` searches device name, not bins. The mobile core cannot get names with any current query; the
live probe confirmed no name field in any alert response. Cheapest path: add `binName`/`siteId`/`siteName` to
the alert response via a device-service lookup (`GET /v1/bins/:id`) or a `read.bin_views` projection.

## What the mobile core calls today

`apps/mobile/src/alerts-client.ts` uses only `alertList`, `alertDetail`, `acknowledgeAlert`. It drops `openWindowStart`,
`resolvedAt`, and never calls any device/reading operation. Any new operation must be added to the BFF
`operations` map and copied byte-for-byte into the mobile client (a test compares them).

## Freshness caveats

- Alert data is authoritative and live (workflow-alerts DB, RLS by tenant).
- Reading data comes from the projection/Cassandra/Elasticsearch stack via the Read API; it lags commit by the
  projection delay (`projectedAt`) and is unavailable when the Read API is down, as it was during this probe.
