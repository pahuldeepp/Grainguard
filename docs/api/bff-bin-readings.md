# Design: `binReadings` (latest and trend readings for a bin)

Status: PROPOSED, design only. Nothing here is implemented. Date: 2026-09-26.
Scope: one BFF query so mobile and dashboard can show real latest and 24 h trend readings for a bin.
Follows: [MOBILE_DATA_AVAILABILITY.md](../MOBILE_DATA_AVAILABILITY.md) (items 16-20), [ADR-0015](../adr/0015-read-cache-and-locks.md) (tenant-scoped cache keys), [ADR-0011](../adr/0011-read-history-retention.md) (hot history), [ADR-0003](../adr/0003-api-versioning.md), and the invariants in `CLAUDE.md`/`AGENTS.md` (tenant isolation layered, no cross-service table writes, BFF read-only).
Architecture rows touched: R3 (write amplification: this design adds no index on the hot write path), R5 (per-tenant limits), H6 (site/bin events; bin names still absent from the read DB).

Evidence conventions: "VERIFIED" = read from source or a read-only SELECT run on 2026-09-26 against the local `greenguard-dev-postgres-1` as `postgres` (superuser, so RLS was bypassed for inspection only). "UNVERIFIED" = not proven live. No token, password or row payload was printed.

## 0. Findings that change the brief

1. **Asset bindings are not bin bindings.** `devices.asset_id` (device-service, `services/device-service/prisma/schema.prisma` model `Device`) and `hardware_assets` (`greenguard_hardware`, columns `asset_id, serial_number, state, owner_saga_id, device_id, fencing_token`) bind a device to a **physical hardware unit**, saga-provisioned (`services/sagas`, STAGE_07_PLAN). A bin is never an asset in any schema. The only device-to-bin link is `devices.bin_id` (inventory, nullable, FK `(tenant_id, site_id, bin_id) -> bins`), carried by inventory events into `read.device_views.bin_id` and into every reading (`reading_history.bin_id`, snapshot at ingest binding time). VERIFIED (`\d devices`, `\d bins`, `\d hardware_assets`; 0 rows where `asset_id <> bin_id`, and `asset_id`-bearing devices are all `provisioning`/`disabled`/`active` with `bin_id` null).
2. **"Moisture" does not exist; relative humidity does.** The only humidity field is `relative_humidity_percent` (air RH, 0-100). Grain moisture content is a different quantity, measured by other sensors that this platform does not ingest. The mobile shell fixtures (`apps/mobile/shell/src/ui/readings.ts`, `demo/data.ts`) label it `moisture` and add `co2Ppm` and `cables`; those are **demo data only**. The API must call the field `relativeHumidity` and the client must not relabel it.
3. **The 24 h window does not fit the existing hot-history routing.** `services/read-api/src/app.ts` uses `safeHotStart = now - hotWindowMs + margin` with defaults `86_400_000` and `300_000`. A request with `from = now - 24h` is older than `safeHotStart`, so `GET .../readings` routes it to Cassandra and `GET .../rollups` rejects it with `rollup_outside_hot_window`. Also `services/read-api/src/main.ts` never passes `hotWindowMs`, so the read API's boundary is a hard-coded 24 h while the projection retention is `PROJECTION_HISTORY_HOT_WINDOW` (ADR-0011 requires them equal). VERIFIED by reading both files (grep for `hotWindow` in `main.ts` returns nothing). Consequence in section 4.
4. **The probe tenant has no bin-bound devices.** For the tenant behind `alice@greenguard.test` (`0a0a0a0a-0000-4000-8000-00000000000a`): 30 `device_views` rows, 0 with `bin_id`; 16 `reading_history` rows, all with `bin_id` null; 11 alert bins. Across the whole local read DB, none of the 2,878 distinct `(tenant, monitored_resource_id)` alert bins in `greenguard_alerts.alert_episodes` has a device in `device_views` or a row in `reading_history`. VERIFIED. So `binReadings` would return "no data" for every alert bin locally until the seed binds devices to bins (task T7). The design must treat unbound bins as a normal case.
5. **Read API still unverified live.** Port 4401 was down in the earlier probe; here only the database was inspected. Every HTTP shape below is source-derived.

## 1. Data wanted versus data that exists

Reading contract (VERIFIED): `contracts/events/telemetry-recorded.v1.schema.json`, `payload.measurements` has exactly two optional numbers (`additionalProperties: false`, `minProperties: 1`): `temperature_c` in [-80, 120] and `relative_humidity_percent` in [0, 100]. Same CHECKs on `greenguard_telemetry.readings`. Nothing else is accepted.

| Item | Exists | Source (store / table / column) | Unit | Sampling interval | Retention | Freshness lag |
| --- | --- | --- | --- | --- | --- | --- |
| Temperature | YES | latest: `read.latest_readings.temperature_c`; history: `read.reading_history.temperature_c` (daily partitions of `public.reading_history` in `greenguard_read`); cold: Cassandra `readings_by_device_day.temperature_c` | degrees C, double | Device-defined; no platform floor. Capacity model assumes ~1/min (ADR-0007). Local synthetic cadence: 170 s (43 rows per 2 h per device, VERIFIED on 3 devices) | Postgres hot: `PROJECTION_HISTORY_HOT_WINDOW`, default 24 h, min 1 h, max 90 d, partitions dropped after upper bound <= now - window - 1 h. Cassandra: TTL from `cassandra-writer/history/schema.go` `default_time_to_live` (value config-driven, UNVERIFIED) | UNMEASURED. Path is commit -> outbox -> CDC -> transformer -> projection. The local `projected_at - received_at` average (56,000 s) comes from replay/backfill rows and says nothing about steady state |
| Relative humidity | YES | same tables, column `relative_humidity_percent` | percent, 0-100 | same as above | same | same |
| Reading timestamps | YES | `observed_at` (device clock), `received_at` (ingest), `projected_at` (read DB) | timestamptz | n/a | n/a | n/a |
| Bin membership | YES | `read.device_views.bin_id` (current) and `reading_history.bin_id` (at ingest) | uuid | on inventory change | rebuildable projection | inventory-event lag, UNMEASURED |
| Bin name / site name | NO in read DB | `greenguard_inventory.bins.name` only (MOBILE_DATA_AVAILABILITY item 13) | n/a | n/a | n/a | out of scope here |
| CO2 | **NO** | in no contract, telemetry table, read table, Cassandra table or event; only in mobile demo fixtures | ppm (proposed) | n/a | n/a | n/a |
| Sensor / cable positions, per-sensor depth | **NO** | no table or column in any migration (device = one point) | n/a | n/a | n/a | n/a |
| Grain moisture content | **NO** | not measured | n/a | n/a | n/a | n/a |
| Per-grain thresholds | PARTIAL, not exposed | `services/risk-engine/risk_engine/scoring.py` `POLICIES`: only `wheat` v1 (temp warn 25 / critical 35 C; RH warn 65 / critical 80 %) and `canola` v1 (22/30 C; 60/75 %), labelled "synthetic ... not calibrated advice", compiled into code, no DB table, no API | C, % | n/a | n/a | n/a |
| Grain type of a bin | PARTIAL, not in read DB | `greenguard_inventory.grain_lots.grain_type` + `bin_occupancies` (write side); `greenguard_risk.bin_lot_intervals` | text | n/a | n/a | n/a |

Rule for this API: expose only the YES rows. No `co2`, `cables`, `moisture` or `thresholds` field appears in the v1 SDL. "Nullable means not available" is applied only where a metric exists but a bin may have no sample (for example a bin whose devices only report temperature).

### 1.1 Separate future item (not part of `binReadings` v1): sensor model and policy data

Owner and stages are proposals; each needs its own ADR and owner approval (CLAUDE.md: an ADR for any decision that changes an invariant).

| Need | Minimal model | Owner |
| --- | --- | --- |
| CO2 | New event schema `telemetry.recorded` v2 (new immutable version, consumers upgraded first per ADR-0003) adding optional `measurements.co2_ppm` with a range chosen by the owner; matching nullable column in `greenguard_telemetry.readings`, `read.reading_history`, Cassandra table; ingest validator and range tests | telemetry-ingest + contracts; then projection-builder, cassandra-writer |
| Cable / sensor positions | Inventory tables `bin_cables(tenant_id, bin_id, cable_id, ordinal, label)` and `cable_sensors(tenant_id, cable_id, sensor_id, ordinal, depth_m)`, forced RLS, composite tenant FKs, emitted through the inventory outbox; readings gain `sensor_samples[] {sensor_id, kind, value}` in a v2 event, projected to a `read.sensor_reading_history` table | device-service (models), telemetry-ingest (contract), projection-builder (read model) |
| Thresholds per grain type | A `grain_policies(grain_type, version, temp_warn_c, temp_critical_c, rh_warn_percent, rh_critical_percent, status)` table owned by risk-engine (replacing the in-code `POLICIES`), published as `risk.policy.changed` events and projected to `read.bin_policy(tenant_id, bin_id, grain_type, policy_version, ...)` through `bin_lot_intervals`. Values stay flagged `calibrated: false` until an agronomist signs them off | risk-engine, then projection-builder |

`binReadings` grows additively when these land: new nullable fields on new types, plus new persisted operation strings (new hashes). No v1 field changes meaning.

## 2. Bin-to-device resolution

Existing path (VERIFIED): `read.device_views (tenant_id, device_id, site_id, bin_id, serial_number, status, inventory_version)`. Written only by projection-builder (`services/projection-builder/store.go`, upsert guarded by `inventory_version <`, so out-of-order inventory events never regress it). Read through view `read.device_views` (`security_invoker`, forced RLS on the base table, migration `000004_read_views.up.sql`). The read API's pool uses `READ_QUERY_DATABASE_URL` (role `read_query`, which has SELECT on `read.device_views`, `read.reading_history`, `read.latest_readings`, `read.device_latest`; migrations 000006, 000007).

Missing: an index or query keyed by `bin_id`. Existing helpers: `getDevice`, `getDevices`, `listDevicesBySite`. There is no `listDevicesByBin`. The table's only index is its primary key `(tenant_id, device_id)`; a per-tenant scan filtered by `bin_id` is fine for a tenant with hundreds of devices but not for 100k. Add `CREATE INDEX device_views_bin ON device_views(tenant_id, bin_id) WHERE bin_id IS NOT NULL` in projection-builder migration `000016` (the table is small and write-rare, so R3 is not affected).

Rules:

- **Bound devices** = rows with `tenant_id=$tenant AND bin_id=$bin AND status IN ('active','disabled')`, `ORDER BY device_id LIMIT 51`. If a bin has more than 50, the resolver returns the first 50 by `device_id` and `deviceCount` reports 50 (the query fetches 51 only to detect this), so the cap is visible to the client; the capacity model expects single-digit devices per bin (VERIFIED locally: max 5 per bin among sampled groups).
- Latest and trend consider `active` devices only. `disabled` devices are listed (status shown) but contribute no metrics; ingest fails closed for them anyway. `deleted` and `provisioning` are excluded (provisioning rows have `bin_id` null in the data: 202 rows).
- **Multiple devices per bin**: supported and expected (VERIFIED: tenants with 2-5 devices per bin). Bin-level `latest` = newest sample per metric across devices; `devices[]` returns each device's own latest so a hot spot is not hidden by a newer but cooler device.
- **Unbound bin** (no device row): the query returns `null` (section 4.4). Unbound device (`bin_id` null): never appears under any bin.
- **Consistency**: `device_views.bin_id` is current state; `reading_history.bin_id` is the binding at ingest time. If a device moves bin A to bin B, old readings keep `bin_id = A`. The trend query filters on `reading_history.bin_id = $bin` AND `device_id = ANY(current active devices)`. Consequence (documented limitation, accepted for v1): a device that has since left the bin no longer contributes its old readings to that bin's trend, and a device that just joined the bin contributes only readings ingested after the move. Fixing that needs a bin index on `reading_history` (write amplification, R3) or a `bin_membership_intervals` projection; deferred (open question Q4).
- **Staleness**: `device_views` lags inventory by the CDC/projection delay (UNMEASURED). During that window a just-bound device is absent. `asOf` and each sample's `observedAt` let the client show what it has.

## 3. GraphQL contract

### 3.1 SDL (added to `typeDefs` in `services/bff/src/schema.ts`)

```graphql
enum ReadingWindow { H1 H6 H24 }
enum ReadingResolution { AUTO M1 M5 M15 H1 }   # AUTO: H1 -> 1 min, H6 -> 5 min, H24 -> 15 min

type MetricSample {          # newest sample of one metric across the bin's active devices
  value: Float!
  observedAt: String!        # ISO-8601 UTC, device clock
  ageSeconds: Int!           # asOf - observedAt, computed per request (never cached)
  stale: Boolean!            # ageSeconds > staleAfterSeconds
  deviceId: ID!
}
type BinDeviceLatest {
  deviceId: ID!
  status: String!            # active | disabled
  observedAt: String         # last reading of any metric; null if the device never reported
  ageSeconds: Int
  stale: Boolean!            # true if never reported or older than staleAfterSeconds
  temperatureC: Float        # null: this device has no temperature sample in the covered history
  relativeHumidityPercent: Float
}
type BinLatest {
  temperature: MetricSample  # null: no active bound device has a temperature sample in covered history
  relativeHumidity: MetricSample
}
type SeriesPoint {
  t: String!                 # bucket start, ISO-8601 UTC, aligned to bucketSeconds
  temperatureMinC: Float     # null when the bucket has no temperature sample
  temperatureAvgC: Float
  temperatureMaxC: Float
  relativeHumidityMinPercent: Float
  relativeHumidityAvgPercent: Float
  relativeHumidityMaxPercent: Float
  sampleCount: Int!          # raw readings in the bucket (any metric)
}
type MetricSummary {
  min: Float!
  avg: Float!                # sample-weighted mean of all raw readings in the window
  max: Float!
  sampleCount: Int!
}
type BinTrend {
  bucketSeconds: Int!
  coveredFrom: String!       # actual start of served history (>= requested start)
  historyTruncated: Boolean! # true when coveredFrom > requested start
  temperature: MetricSummary      # null: no temperature samples in the window
  relativeHumidity: MetricSummary
  points: [SeriesPoint!]!    # ascending by t, sparse (empty buckets omitted), at most 288
}
type BinReadings {
  binId: ID!
  asOf: String!              # server time used for ageSeconds
  staleAfterSeconds: Int!    # server constant, see 4.6
  deviceCount: Int!          # active + disabled bound devices, capped at 50
  devices: [BinDeviceLatest!]!
  latest: BinLatest!
  trend(window: ReadingWindow!, resolution: ReadingResolution!): BinTrend!
}
extend type Query {
  binReadings(binId: ID!): BinReadings   # null = not found, foreign, or no device bound (section 4.4)
}
```

Notes:

- `trend` is a field with arguments so the latest operation never pays for the trend query: the resolver runs a backend call only for selected fields.
- Times are ISO strings, like every existing type (`ReadingView.observedAt`). Numbers are `Float`; no bigint appears.
- `resolution` finer than 288 buckets for the window (for example `M1` with `H24`) fails with `BAD_USER_INPUT` code `resolution_too_fine`. `AUTO` never fails.
- Bucket alignment: `date_bin(interval, observed_at, TIMESTAMPTZ '2001-01-01 00:00:00+00')`, so buckets are stable across requests and cache entries.

### 3.2 Size and pagination

The series is bounded, not paginated: at most 288 points (24 h at 5 min), at most 50 devices, no cursor. A cursor would add nothing because the result is an aggregate over a fixed window. Payload budget: about 140 B per point, so 288 points is about 40 KB JSON and `AUTO` (96 points) about 14 KB; hard budget 64 KiB uncompressed for any legal request (well under ADR-0015's 256 KiB cache value cap; asserted by test BR-RA-09). Gzip is applied by the gateway.

### 3.3 Persisted operations (add to `operations` in `services/bff/src/query-policy.ts`)

Two operations, because one combined selection has 49 fields (26 + 26 less the shared `binReadings`, `binId` and `asOf` fields) and `assertQueryBudget` allows 40 fields at depth 6. Splitting also gives independent failure and cache behaviour (section 4.5). Field counts, measured with the same `visit` logic as `assertQueryBudget`: latest operation 26 fields, trend operation 26 fields, both at depth 4 (limits 40 and 6).

```ts
binReadingsLatest: `query BinReadingsLatest($binId: ID!) { binReadings(binId: $binId) { binId asOf staleAfterSeconds deviceCount devices { deviceId status observedAt ageSeconds stale temperatureC relativeHumidityPercent } latest { temperature { value observedAt ageSeconds stale deviceId } relativeHumidity { value observedAt ageSeconds stale deviceId } } } }`,
binReadingsTrend: `query BinReadingsTrend($binId: ID!, $window: ReadingWindow!, $resolution: ReadingResolution!) { binReadings(binId: $binId) { binId asOf trend(window: $window, resolution: $resolution) { bucketSeconds coveredFrom historyTruncated temperature { min avg max sampleCount } relativeHumidity { min avg max sampleCount } points { t temperatureMinC temperatureAvgC temperatureMaxC relativeHumidityMinPercent relativeHumidityAvgPercent relativeHumidityMaxPercent sampleCount } } } }`,
```

(Test BR-PO-03 must keep asserting `assertQueryBudget`; if a later addition pushes either operation over 40 fields, split the operation again rather than raising the shared budget. A single combined operation would have 49 fields, which is why there are two.)

Wiring in the same file family:

- `rate-limit.ts` `operationCharge`: `binReadingsLatest` -> `{group:"read", cost:2}`; `binReadingsTrend` -> `{group:"read", cost:5}`. Reason: same cost class as `siteDevices` and `readingRollups`. With the per-user read bucket (capacity 100, refill 10/s) that allows 20 trend calls in a burst, then 2 per second.
- `main.ts` `machineReadOperations`: NOT added in v1 (machine principals keep the current six read operations). Open question Q5.
- Mobile copy: `apps/mobile/src/` operations must be byte-identical to `query-policy.ts` (existing test "operations match the BFF persisted-query allowlist text" in `apps/mobile/src/alerts-client.test.ts` does a `source.includes(query)` check; the new client gets the same test).

## 4. Read path

### 4.1 Where the work happens

Options weighed:

| Option | Verdict |
| --- | --- |
| BFF composes `siteDevices`/`device` + `deviceHistory`/`readingRollups` per bound device | Rejected. N+1 (one history call per device, each costing rate-limit units 5-10), and `readingHistory` is capped at 100 raw rows per call, while 24 h at 170 s is about 508 rows per device, so the trend would be silently truncated. `readingRollups` supports only `hour`/`day` buckets and cannot serve a 24 h window (finding 3). No single call would give a bin-level aggregate; the BFF would merge in TypeScript. |
| Read API gains bin routes; BFF stays a thin translator | **Chosen.** One indexed SQL per operation inside one tenant transaction, aggregation next to the data, one cache entry per bin, bulkheads already exist in that service, and the BFF keeps its "read-only translator" role (`services/bff/src/read-client.ts` pattern). |
| New service | Rejected: no new write owner is needed; the data is the existing read projection. |

New routes in `services/read-api/src/app.ts` (router already enforces roles `viewer|operator|admin` or service scope `read:telemetry`, and sets `res.locals.tenantId` from the verified principal):

- `GET /api/v1/read/bins/:binId/readings/latest` -> `{ data: { bin_id, as_of, devices: [...], latest: {...} } | null, source: "postgres" }`
- `GET /api/v1/read/bins/:binId/readings/trend?window=1h|6h|24h&resolution=auto|1m|5m|15m|1h` -> `{ data: { bucket_seconds, covered_from, history_truncated, temperature, relative_humidity, points } | null, source: "postgres" }`

Both validate `binId` with the existing `uuid()` helper (`invalid_id`), reject unknown enum values (`invalid_window`, `invalid_resolution`, `resolution_too_fine`), and never accept a tenant parameter.

### 4.2 Queries (new functions in `packages/read-model/src/index.ts`, all inside `withReadTenant`, i.e. `BEGIN READ ONLY` + `set_config('app.tenant_id', $1, true)`)

`listActiveDevicesByBin(tx, tenantId, binId, limit=51)`:

```sql
SELECT device_id, serial_number, status
FROM read.device_views
WHERE tenant_id=$1 AND bin_id=$2 AND status IN ('active','disabled')
ORDER BY device_id LIMIT $3
```

`getBinLatest(tx, tenantId, deviceIds, since)` (one statement; per device and per metric the newest non-null sample inside covered history, plus the device's last reading time from `read.device_latest`, which outlives history):

```sql
SELECT d.device_id,
       l.selected_observed_at AS last_observed_at,
       t.observed_at AS temp_at, t.temperature_c,
       h.observed_at AS rh_at,  h.relative_humidity_percent
FROM unnest($2::uuid[]) AS d(device_id)
LEFT JOIN read.device_latest l ON l.tenant_id=$1 AND l.device_id=d.device_id
LEFT JOIN LATERAL (SELECT observed_at, temperature_c FROM read.reading_history
   WHERE tenant_id=$1 AND device_id=d.device_id AND bin_id=$4 AND temperature_c IS NOT NULL AND observed_at >= $3
   ORDER BY observed_at DESC, stream_version DESC LIMIT 1) t ON true
LEFT JOIN LATERAL (SELECT observed_at, relative_humidity_percent FROM read.reading_history
   WHERE tenant_id=$1 AND device_id=d.device_id AND bin_id=$4 AND relative_humidity_percent IS NOT NULL AND observed_at >= $3
   ORDER BY observed_at DESC, stream_version DESC LIMIT 1) h ON true
```

`$3` = `coveredFrom` (see 4.3). It bounds partition pruning; without it the lateral would visit every partition. It uses the existing index `reading_history_device_time (tenant_id, device_id, observed_at DESC, stream_version DESC)`. Why not `read.latest_readings`: it exposes only the single newest reading per device, whose temperature may be null even when a moment earlier one existed (readings may carry either metric). Bin-level `latest.<metric>` = the row with the greatest `*_at`, ties by `device_id`.

`getBinTrend(tx, tenantId, binId, deviceIds, from, to, bucketSeconds)`:

```sql
SELECT date_bin(make_interval(secs => $6), observed_at, TIMESTAMPTZ '2001-01-01 00:00:00+00') AS bucket,
       min(temperature_c), avg(temperature_c), max(temperature_c), count(temperature_c)::int,
       min(relative_humidity_percent), avg(relative_humidity_percent), max(relative_humidity_percent), count(relative_humidity_percent)::int,
       count(*)::int
FROM read.reading_history
WHERE tenant_id=$1 AND bin_id=$2 AND device_id = ANY($3::uuid[]) AND observed_at >= $4 AND observed_at < $5
GROUP BY 1 ORDER BY 1
```

At most 288 rows returned; work is bounded by `<= 50 devices x readings in window` (for 50 devices at 1/min for 24 h that is 72,000 rows scanned, an index range scan per device; the performance test in section 5 measures it, the budget is UNMEASURED). The summary is computed in TypeScript from the bucket rows: `min(mins)`, `max(maxes)`, `sum(avg*count)/sum(count)`, `sum(count)` (exact for a weighted mean). Averages are sample-weighted, so a chattier device weighs more; this is stated in the SDL comment (Q3).

### 4.3 Hot-history boundary (finding 3)

The bin routes never touch Cassandra or Elasticsearch: every legal window (up to 24 h) is answered from Postgres hot history. To keep that honest:

1. Add `READ_HISTORY_HOT_WINDOW` and `READ_HISTORY_BOUNDARY_MARGIN` env parsing to `services/read-api/src/main.ts` and pass `hotWindowMs`/`hotBoundaryMarginMs` to `createApp` (fixes the hard-coded-default drift; deploy with the same value as `PROJECTION_HISTORY_HOT_WINDOW` per ADR-0011).
2. `coveredFrom = max(now - windowMs, now - hotWindowMs + margin)` and `historyTruncated = coveredFrom > now - windowMs`. With today's defaults (24 h, 5 min) a `24h` request reports `historyTruncated: true` and `coveredFrom` 5 minutes late. Recommended deployment setting: `PROJECTION_HISTORY_HOT_WINDOW=48h` and the same read-API value, so `24h` is never truncated; storage cost is one extra day of partitions (UNMEASURED; owner to confirm, Q2).
3. The client renders `coveredFrom` and, if `historyTruncated`, a "history starts at ..." note instead of pretending to cover 24 h.

### 4.4 Tenant isolation, not-found and authz

- Tenant comes only from the verified principal (`res.locals.tenantId`); the BFF forwards the caller's own `Authorization` header (as `ReadClient` does today) and never a tenant argument. Layers: token tenant -> `withReadTenant` `set_config` -> forced RLS on `public.device_views` and each `reading_history` partition (invoker views) -> explicit `tenant_id=$1` in every predicate -> tenant-scoped cache key.
- **Foreign or unknown bin id**: the device list query returns zero rows, and the route returns `data: null`; the resolver returns GraphQL `null` with no error. A bin that exists in the caller's tenant but has no bound device is indistinguishable from a foreign or nonexistent bin, by design: there is no bin table in the read DB, so existence cannot be checked, and 404-versus-403 differences would leak. The same status, body shape and query plan are used for all three cases. (The client can already show the bin from the alert; the UI copy for `null` is "No sensors are bound to this bin", never "not found".) This gap disappears if a `read.bin_views` projection lands (H6); then a real 404 would be possible for unknown ids while foreign ids still look identical.
- **Authz**: roles `viewer`, `operator`, `admin` (read-only, same as every read-api route). Service principals need scope `read:telemetry` at the read API, and the BFF blocks them from these operations in v1 (see 3.3).
- **Cache key scoping (ADR-0015)**: new kinds `binLatest` and `binTrend` in `cacheBackends` (`services/read-api/src/cache.ts`), args `[binId]` and `[binId, window, resolution]` (no time argument: `coveredFrom` is derived after the cache, and buckets are aligned so identical requests share one entry). Resulting key `gg:read:v1:{t:<tenant>}:g<generation>:<sha256(kind,args)>`, checked envelope `{t,k,v}`, tenant ID pattern guard, 15 s TTL + 0-20 % jitter, 256 KiB cap, 50 ms command timeout, breaker, single-flight lock, fallback to the owner store on any Redis fault. Only the raw query rows are cached; `asOf`, `ageSeconds`, `stale` and `deviceCount` are computed after the cache read so a cached entry never reports a stale age.
- **Invalidation**: per-device version stamps (used by `latest`/`hot`) cannot key a multi-device entry. v1 relies on the tenant generation (structural bumps: device or bin binding changes) plus the 15 s TTL. Staleness bound for telemetry: TTL x 1.2 = 18 s plus projection lag. The comment in `cache.ts` cites "ADR-0016" for device versioning, but no `docs/adr/0016-*.md` exists (VERIFIED by `ls docs/adr`); the implementer must record that gap or write the ADR before extending stamps to multi-device keys (Q6).
- **Limits and quotas**: BFF token bucket costs (3.3); the read API already enforces per-tenant bulkheads only for Cassandra/Elasticsearch, so the new Postgres route gets its own per-tenant concurrency cap (default 4 in flight, global 32, `BulkheadFull` -> 503 `read_busy` + `Retry-After: 1`) and a `SET LOCAL statement_timeout = '2s'` inside the transaction (none exists in `read-model` today, VERIFIED by grep). History-range entitlements (`assertHistoryRange`, plan days) already allow 24 h; the routes call it for parity so a plan below 24 h answers `403 entitlement_exceeded` (already mapped by `app.ts`).

### 4.5 Partial-failure contract

| Failure | Behaviour |
| --- | --- |
| Redis down / slow / breaker open | Transparent: read API serves from Postgres; response identical (ADR-0015 rule 8). |
| Cassandra down | No effect: not on this path (all windows <= 24 h are Postgres-only; 4.3). |
| Elasticsearch down | No effect. |
| Read Postgres down or statement timeout on the **latest** query | `binReadingsLatest` fails as a whole: GraphQL `errors[0].extensions.code = "read_unavailable"` (HTTP status 503 in `extensions.httpStatus`), `data.binReadings` absent. There is no cheaper data to fall back to. |
| Same fault on the **trend** query only | `binReadingsTrend` fails; the UI still holds a successful `binReadingsLatest` result and renders latest with a "trend unavailable, retry" state. This is why the two operations are separate persisted operations: each fails independently instead of one GraphQL response carrying half a bin. |
| Read API unreachable from BFF | `translate()` already maps to `read_api_unavailable` (503, `ReadUpstreamError`). |
| Read API bulkhead full | 503 `read_busy` with `Retry-After: 1`; client retries with jitter, at most twice. |
| BFF rate limit | HTTP 429 `rate_limited` with `Retry-After`. |
| Rate-limit Redis down | Existing fail-closed 503 `rate_limit_unavailable` (unchanged). |
| Projection stalled (data old but DB healthy) | Success with old `observedAt`, `ageSeconds` large, `stale: true`. Staleness is data, not an error. |
| History pruned to less than requested | Success with `historyTruncated: true` and `coveredFrom`. |
| Bin has devices but no readings in covered history | Success: `latest.*` null, `devices[].stale: true`, `trend.points: []`, summaries null. |

### 4.6 Staleness definition

`staleAfterSeconds` is a BFF/read-api constant `BIN_READINGS_STALE_AFTER_SECONDS`, default 900 (15 minutes: about 5 missed samples at the 170 s local cadence, 15 at the modelled 1/min). It is returned in every response so the client never hard-codes it. A device that never reported is `stale: true` with null `observedAt`. The value is a product decision (Q1); it is not an agronomic threshold.

### 4.7 Performance budget (all UNMEASURED; to be measured, not assumed)

| Path | Budget (p95) |
| --- | --- |
| Read API `binLatest`, cache miss, 50 devices | 60 ms |
| Read API `binTrend`, cache miss, 24 h, 50 devices x 1/min | 150 ms |
| Cache hit | 10 ms |
| BFF end-to-end `binReadingsLatest` / `binReadingsTrend` | 300 ms (the backlog's Tier 1 API p95 target, `IMPLEMENTATION_BACKLOG.md` stage 13) |
| Response size | <= 64 KiB uncompressed |
| Statement timeout | 2 s (fail rather than queue) |

Measurement plan: seed 50 devices x 1,440 readings (72,000 rows) for one bin, run the two routes with warm and cold cache and record p50/p95/p99 and rows scanned (`EXPLAIN (ANALYZE, BUFFERS)` saved under `evidence/`); only then may the table be edited from "budget" to "measured".

## 5. Test-first plan

Convention: write the named failing test first; node tests use `node:test` as in `services/read-api/src/app.test.ts` and `services/bff/src/*.test.ts`; Go untouched. IDs are `BR-<layer>-<n>`.

| Layer | First failing test | Further tests |
| --- | --- | --- |
| Read-model (`packages/read-model/src/index.test.ts`, live DB fixture like existing tests) | **BR-RM-01** `listActiveDevicesByBin` returns only active/disabled devices of the requested tenant and bin, ordered, limit 51 | BR-RM-02 excludes deleted/provisioning/unbound; BR-RM-03 `getBinTrend` buckets align to `date_bin` origin and omit empty buckets; BR-RM-04 min/avg/max/count per metric with a bucket that has temperature but no humidity (null, not zero); BR-RM-05 `getBinLatest` returns newest non-null per metric even when the newest reading lacks that metric; BR-RM-06 reading with old `bin_id` (device moved) is excluded from the new bin; BR-RM-07 two tenants with the same `bin_id` and device ids see only their own rows (RLS plus predicate); BR-RM-08 `EXPLAIN` uses `reading_history_device_time`, no seq scan on more than one partition when `since` is set |
| Read-api route (`services/read-api/src/app.test.ts`, `cache.test.ts`) | **BR-RA-01** `GET /bins/:id/readings/latest` with a fake backend returns `{data, source:"postgres"}` and passes `res.locals.tenantId`, never a query-string tenant | BR-RA-02 invalid uuid -> 400 `invalid_id`; BR-RA-03 bad window/resolution -> 400; BR-RA-04 `M1`+`H24` -> `resolution_too_fine`; BR-RA-05 unbound bin -> `data:null`; BR-RA-06 `ageSeconds` computed from injected `now`, and a cached entry re-ages on a later hit; BR-RA-07 `coveredFrom`/`historyTruncated` with default 24 h + 5 min margin, and none with a 48 h window; BR-RA-08 service principal without `read:telemetry` -> 403, viewer allowed; BR-RA-09 worst-case body (288 points, 50 devices) <= 64 KiB; BR-RA-10 cache key contains `{t:<tenant>}`, kind `binTrend`, no bin id in clear; BR-RA-11 Redis fault serves from origin; BR-RA-12 concurrency cap -> 503 `read_busy`; BR-RA-13 statement timeout -> 503 `read_unavailable`; BR-RA-14 entitlement below 24 h -> 403 `entitlement_exceeded` |
| BFF resolver (`services/bff/src/schema.test.ts`, `read-client.test.ts`) | **BR-BF-01** `binReadings(binId)` resolver calls `ReadClient.binLatest` with the caller's authorization and maps snake_case wire rows to the SDL types | BR-BF-02 `trend` field runs only when selected (spy: latest operation makes zero trend calls); BR-BF-03 wire `null` -> GraphQL `null`, no error; BR-BF-04 upstream 503 `read_unavailable` -> `extensions.code` and `httpStatus`; BR-BF-05 `binId` not a UUID -> `BAD_USER_INPUT` before any upstream call; BR-BF-06 the resolver never puts a tenant in the URL or query string |
| Persisted-op contract (`services/bff/src/query-policy.test.ts`) | **BR-PO-01** `operations.binReadingsLatest` and `binReadingsTrend` exist, their hashes are in `persistedOperations`, and `persistedOperations.size === Object.keys(operations).length` still holds | BR-PO-02 both parse and validate against `typeDefs` with `graphql.validate`; BR-PO-03 `assertQueryBudget` passes (counts <= 40 fields, depth <= 6); BR-PO-04 an ad-hoc `binReadings` query without the hash -> 400 `persisted_operation_required`; BR-PO-05 `rate-limit.test.ts` charges cost 2 and 5; BR-PO-06 service principal is 403 for both |
| Degradation (BFF + read-api) | **BR-DG-01** latest succeeds while the trend backend rejects; the client-visible results are independent | BR-DG-02 Redis outage: identical response to cache-hit response; BR-DG-03 Cassandra and Elasticsearch stubs throwing do not affect either route (must never be called); BR-DG-04 read-api down -> `read_api_unavailable`; BR-DG-05 stale data returns success with `stale:true` |
| Cross-tenant denial (`tests/integration` live, plus unit) | **BR-XT-01** tenant B requests tenant A's real `bin_id`: response is `null`, identical body and status to a random uuid, and zero tenant A rows appear | BR-XT-02 cache: A warms the entry, B's identical request misses and never reads A's envelope (mismatch counter 0 or handled); BR-XT-03 forged `tenant` variable/query parameter ignored; BR-XT-04 a crafted cache value with another tenant's `t` is rejected (`mismatch`); BR-XT-05 GraphQL alias batching of 40 foreign ids still costs rate-limit units per operation |
| Mobile client (`apps/mobile/src`, new `bin-readings-client.ts` + test) | **BR-MC-01** the client's operation strings are byte-identical to `query-policy.ts` (copy of the existing `alerts-client.test.ts` check) | BR-MC-02 sends only `{variables, extensions.persistedQuery}` and the bearer token, no tenant; BR-MC-03 maps `null` -> "No sensors bound" state, not an error; BR-MC-04 trend failure leaves latest displayed; BR-MC-05 renders `historyTruncated` note; BR-MC-06 shell shows relative humidity (labelled as such) and no CO2/cables/moisture in live mode; the demo fixtures stay behind the demo flag |
| Dashboard client (`apps/dashboard/src/ReadViews.test.tsx`, `graphql-client.ts`) | **BR-DC-01** a `BinReadings` panel renders latest values with a stale badge from a mocked `binReadingsLatest` response | BR-DC-02 trend table/chart for 24 h with `AUTO`; BR-DC-03 empty and unbound states; BR-DC-04 query key includes the session id (no cross-session cache reuse, as existing read views do); BR-DC-05 a11y: axe on the panel |
| Live E2E (`scripts/`, after T7 seed) | **BR-E2E-01** two tenants, each with one bin bound to two devices, real ingest -> projection -> BFF; the BFF latest equals the last accepted reading | BR-E2E-02 Redis kill and recovery; BR-E2E-03 device moved between bins |

## 6. Rollout, compatibility, risks, questions, tasks

### 6.1 Rollout and compatibility

- Purely additive: two new persisted operations and one new nullable `Query` field. No existing operation, type or route changes. Old mobile builds never send the new hashes, so they are unaffected; new builds against an old BFF get `operation_not_allowed` (400), which the client must map to "update or try again later" rather than a generic error.
- Header versioning (ADR-0003): none needed; fields are only ever added. A removal or meaning change would need a new `API-Version`.
- Deploy order: (1) projection-builder migration 000016 (index), (2) read-api with routes, (3) BFF with operations, (4) mobile and dashboard. Feature-gate the UI panel on the operation existing (a 400 `operation_not_allowed` hides it).
- `READ_HISTORY_HOT_WINDOW` must equal `PROJECTION_HISTORY_HOT_WINDOW` in every environment; add it to `.env.example`, `docs/SETUP.md`, and the compose files.
- Docs to update when built: `docs/MOBILE_DATA_AVAILABILITY.md` items 16, 18 (from PARTIAL to YES with evidence), a saved live probe under `evidence/`, and `docs/MILESTONES.md` only with linked evidence (project rule).

### 6.2 Risks

1. Trend query cost with many devices or long windows (mitigated by device cap 50, window cap 24 h, 2 s timeout, cache, bulkhead; still UNMEASURED).
2. Bin-scoped trend ignores readings from devices that left the bin (accepted, documented; alternative costs write amplification, R3).
3. No real readings locally for alert bins (finding 4): the feature looks empty until seed and ingest are wired; risk of "works in test, empty in demo".
4. Hot-window drift between projection-builder and read-api (finding 3) can make the API claim history it no longer has; mitigated by `coveredFrom`.
5. Mislabelled semantics (RH shown as "moisture") could cause wrong grain decisions; mitigated by naming and by task T5/T6 UI copy.
6. Cache staleness up to about 18 s plus projection lag can lag a just-fired alert; mitigated by showing `observedAt`/`ageSeconds`.
7. Sample-weighted averages favour chatty devices (Q3).
8. A `null` response conflates unknown, foreign and unbound bins (deliberate; costs UX precision until `bin_views` exists).
9. Rate-limit abuse by many bin ids: cost is per operation, bins are not batched; an attacker with a valid token is bounded by the per-user bucket.

### 6.3 Open questions for the owner

- Q1: default `staleAfterSeconds` (proposed 900) and whether it should differ per device class.
- Q2: set `PROJECTION_HISTORY_HOT_WINDOW` to 48 h so a full 24 h trend is never truncated (proposed), or accept `historyTruncated` at 24 h.
- Q3: bin averages as sample-weighted mean (proposed) or mean of per-device means.
- Q4: is losing old readings of devices that left a bin acceptable for v1, or do we build a bin membership interval projection now?
- Q5: allow machine principals (`read:telemetry`) to call the bin operations?
- Q6: write ADR-0016 (device-version cache stamps; referenced in `cache.ts` but absent) and decide whether multi-device entries need per-device stamps instead of TTL.
- Q7: approve the separate sensor/policy item (1.1) and its owners; until then the UI shows "not measured" for CO2, cables and grain moisture.
- Q8: who seeds bin-bound devices for the demo tenant (T7), since none exist for `alice`'s tenant?
- Q9: should the read-api Postgres routes get the per-tenant bulkhead (proposed) or rely only on BFF rate limits?

### 6.4 Ordered task list (one implementer each; file ownership listed so tasks do not collide)

| # | Task | Owns (may edit) | Depends on | Done when |
| --- | --- | --- | --- | --- |
| T0 | Align read-api hot window with projection retention: parse `READ_HISTORY_HOT_WINDOW`/margin in `main.ts`, pass to `createApp`, document in `.env.example` and `docs/SETUP.md` | `services/read-api/src/main.ts`, `main` tests, `.env.example`, `docs/SETUP.md` | none | test proves env is honoured and invalid values stop startup |
| T1 | Read-model queries + migration 000016 (`device_views_bin` index) | `packages/read-model/src/index.ts`, `index.test.ts`, `services/projection-builder/migrations/000016_*.sql` and its migration tests | none | BR-RM-01..08 green on live DB |
| T2 | Read-api routes, bulkhead, statement timeout, cache kinds | `services/read-api/src/app.ts`, `backends.ts`, `bulkhead.ts`, `cache.ts` and their tests | T0, T1 | BR-RA-01..14, BR-DG-02/03 green |
| T3 | BFF: SDL types, resolver, `ReadClient` methods, persisted ops, rate-limit costs | `services/bff/src/schema.ts`, `read-client.ts`, `query-policy.ts`, `rate-limit.ts`, their tests | T2 (wire shape) | BR-BF-*, BR-PO-*, BR-DG-01/04/05 green |
| T4 | Cross-tenant and live integration tests | `tests/integration/**` (new files only) | T2, T3 | BR-XT-01..05 green against real Redis and Postgres |
| T5 | Mobile client and shell wiring (live mode uses the API; demo fixtures untouched) | `apps/mobile/src/bin-readings-client.ts` (+test), `apps/mobile/shell/src/ui/readings.ts`, `ReadingViews.tsx`, `BinProfile.tsx` | T3 | BR-MC-01..06 green; live mode shows RH and temperature only |
| T6 | Dashboard panel | `apps/dashboard/src/ReadViews.tsx` (+test), `graphql-client.ts` | T3 | BR-DC-01..05 green |
| T7 | Seed and live E2E: bind devices to bins for the demo tenant, ingest, verify | `scripts/**` (new e2e script), `tests/fixtures/**` | T3 | BR-E2E-01..03 pass; a probe of alert bins returns real values; evidence saved under `evidence/` |
| T8 | Measure the performance budget and update section 4.7 | `evidence/**`, this document | T2, T7 | p50/p95/p99 and `EXPLAIN` saved |
| T9 | Separate future item: ADR for CO2, cable/sensor model and grain policies (section 1.1) | `docs/adr/00xx-*.md` only until approved | owner approval (Q7) | ADR accepted, then staged into telemetry-ingest, device-service, risk-engine, projection-builder |

Each of T1-T6 runs `make verify`, keeps the 80 % coverage gate, runs `coderabbit review`, and the tenant-isolation-reviewer agent (tenant data paths), per `AGENTS.md`/`CLAUDE.md`. Commit once per finished task batch; do not commit or push unless the owner asks.

## 7. Evidence log (read-only commands run 2026-09-26)

- `\l` and `information_schema.tables` on `greenguard_read`, `greenguard_telemetry`, `greenguard_inventory`, `greenguard_sagas`, `greenguard_alerts`, `greenguard_hardware`, `greenguard_risk`.
- `\d` of `devices`, `bins`, `grain_lots`, `bin_occupancies`, `hardware_assets`, `device_bindings`, `readings`, `alert_episodes`.
- Counts only: `reading_history` 2,328 rows / 234 devices, dated 2026-09-23 to 2026-09-26, newest 10 h 56 min old at query time (no live producer); `device_latest` 1,179; `device_views` 2,728 (1,768 with a bin, 960 without); tenants with 2-5 devices per bin exist; `alice`'s tenant as in finding 4; alert-bin overlap 0 of 2,878.
- Source read: `services/read-api/src/{app,backends,cache,bulkhead,main}.ts`, `entitlements/history.ts`; `services/bff/src/{schema,query-policy,read-client,device-loader,rate-limit,main}.ts`; `packages/read-model/src/index.ts`; `services/projection-builder/migrations/000001,000002,000004,000006,000007`; `store.go`; `services/cassandra-writer/history/schema.go`; `contracts/events/telemetry-recorded.v1.schema.json`; `services/risk-engine/risk_engine/scoring.py`; `services/device-service/prisma/schema.prisma`; `apps/mobile/src/graphql.ts`, `apps/mobile/shell/src/ui/readings.ts`; `apps/dashboard/src/ReadViews.tsx` (reads per device only: latest reading, history, rollups).
