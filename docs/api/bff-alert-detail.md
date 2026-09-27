# Design: enriched BFF alert queries (rule, thresholds, bin and site context)

Status: PROPOSED, design only. Nothing here is implemented. Written 2026-09-26 from source reading; no service was run.
Inputs: [MOBILE_DATA_AVAILABILITY.md](../MOBILE_DATA_AVAILABILITY.md), [live evidence](../../evidence/MOBILE_DATA_AVAILABILITY_LIVE.md),
ADR-0014 (OIDC identity), ADR-0015 (read cache), ADR-0017 (control plane), [STAGE_05_PLAN.md](../STAGE_05_PLAN.md), `AGENTS.md`, `ARCHITECTURE_REVIEW.md` (H5, H6).

Notation: **VERIFIED** = I read the file and line named. **UNVERIFIED** = inferred, needs the implementer to confirm.

## 1. Problem and wanted fields

Mobile (`apps/mobile/src/alerts-client.ts`) and dashboard (`apps/dashboard/src/alerts-api.ts`, `AlertsView.tsx`) show an alert as a bare
`ruleId` and `binId` UUID (dashboard renders `Bin <uuid>` at `AlertsView.tsx:382,436`). Operators need the rule name, the thresholds that
fired it, and which bin and site it is. The persisted `alertList` and `alertDetail` documents in `services/bff/src/query-policy.ts` do not
select several fields the BFF and owner already return.

| # | Field (GraphQL) | Meaning | Today |
| --- | --- | --- | --- |
| F1 | `rule.ruleKey` | rule name, e.g. `grain-risk-default` | not exposed |
| F2 | `rule.openScore` | alert opens when score >= this (`policy.ts:77`, VERIFIED) | not exposed |
| F3 | `rule.clearScore` | alert resolves when score < this (`policy.ts:80`, VERIFIED) | not exposed |
| F4 | `rule.escalationTimeoutSeconds` | unacknowledged escalation delay (default 900) | not exposed |
| F5 | `rule.resourceKind` | monitored resource kind (only `bin` by CHECK constraint) | not exposed |
| F6 | `bin.name` | human bin name | not exposed |
| F7 | `bin.siteId` | site of the bin | not exposed (alert row has no site) |
| F8 | `bin.siteName` | human site name | not exposed |
| F9 | `resolvedAt` | when the episode resolved | in `AlertView` schema and REST DTO, not selected by any persisted op |
| F10 | `openWindowStart` | episode window key | same as F9 |
| F11 | `escalatedAt` | when the last escalation happened | `alert_episodes.escalated_at` exists; not in `toAlertDto` |
| F12 | `acknowledgedBy` in the list | opaque Dex subject | only in `alertDetail`; still not a display name |
| F13 | `grainType` | grain in the bin when the alert opened | not exposed |

Important semantic: F2/F3 are **risk-score thresholds (0-100)**, not temperature or humidity limits. UI copy must say "score", never imply degrees.
Per-grain temperature limits live in risk-engine policy and are out of scope.

Out of scope: display name for `acknowledgedBy` (needs a membership lookup, ADR-0017 owner is `tenant-control-plane`), CO2, per-sensor data,
alert transitions history, notification log (see MOBILE_DATA_AVAILABILITY items 17, 20, 22-25).

## 2. Ownership and read path per field

Rule: one write owner per aggregate; no service reads another service's tables (`CLAUDE.md` invariants). The BFF composes through owner APIs.

| Field | Authoritative owner | Store | Read path chosen | Why not the alternatives |
| --- | --- | --- | --- | --- |
| F9, F10 | workflow-alerts | `alert_episodes.resolved_at`, `open_window_start` (`prisma/migrations/20260924100000_alert_lifecycle`, VERIFIED) | Already returned by `GET /v1/alerts` and `/v1/alerts/:id` (`api/parse.ts` `toAlertDto`, VERIFIED) and typed in `services/bff/src/alerts.ts` `AlertView`. BFF-only change: select them in the new persisted ops. | Nothing to add. |
| F12 (list) | workflow-alerts | `alert_episodes.acknowledged_by` | Same as above; select in list op. | Display name is a separate control-plane feature. |
| F11 | workflow-alerts | `alert_episodes.escalated_at` (already in `EpisodeRow`/`Episode.escalatedAt`, `store.ts:39,58`, VERIFIED) | Add `escalatedAt` to `toAlertDto` in `api/parse.ts` (additive REST field). **Touches workflow-alerts.** | Deriving from transitions needs a route that does not exist. |
| F1-F5 | workflow-alerts | `alert_rules` (`rule_key`, `resource_kind`, `open_score`, `clear_score`, `escalation_timeout_seconds`), PK `(tenant_id, rule_id)`, forced RLS, `alerts_app` has SELECT (VERIFIED) | New read-only route `GET /v1/alert-rules?ids=<uuid,uuid,...>` (max 50) in `api/alerts.controller.ts` (or a sibling controller) plus `store.ts` `findRules(tx, tenantId, ids)` under `withTenant`. BFF resolves `AlertView.rule` through a per-request DataLoader. **Touches workflow-alerts.** | Joining `alert_rules` into `listEpisodes` would change the `SELECT *` shape shared with the lock paths (`lockActiveEpisode`, `lockEpisode`) that the lifecycle code depends on; a separate route leaves the write path untouched. A BFF read of `greenguard_alerts` is forbidden. |
| F6-F8 | device-service owns `sites`/`bins` (`prisma/schema.prisma` models `Site`, `Bin`: `name`, `site_id`, `version`, VERIFIED). Read-side owner: projection-builder read DB | **Currently NOT projected** (see below) | Build `bin_views` and `site_views` in the read DB from `greenguard.inventory.facility.v1`, expose `POST /api/v1/read/bins/batch` in read-api, BFF `ReadClient.bins()` and DataLoader. | Details below. |
| F13 | risk-engine emits it; device-service owns lots (`grain_lots.grain_type`, `bin_occupancies`) | `risk.assessed` payload has `grain_type` (`contracts/events/risk-assessed.v1.schema.json:23,32`, VERIFIED) | Snapshot into `alert_episodes` at open from the risk event workflow-alerts already consumes. **Touches workflow-alerts. Phase 3, gated by open question Q3.** | A live lookup by current lot would show a different grain than the one that fired the alert after a lot change. A cross-service call to risk-engine is a new coupling. |

### 2.1 Verification of the "names exist only in device-service" claim

The investigator concluded names are only in device-service. I checked; the conclusion holds for the read DB, with two nuances.

- VERIFIED: the read DB has no facility tables. `services/projection-builder/migrations/000001..000015` create only `consumer_inbox`,
  `projection_streams`, `device_views`, `reading_history`, `device_latest`, `stream_gaps`, `projection_notifications`,
  `projection_checkpoints`, replay tables, writer lease, `outbox_events`, entitlements. `device_views` has `site_id`, `bin_id`, `serial_number`
  but no bin or site name. `packages/read-model/src/index.ts` exports only device, reading, latest and freshness queries.
- VERIFIED: the facility events **are** produced and routed. `services/device-service/README.md:41` says site/bin creation writes
  `site.changed` / `bin.changed` with outbox, audit and receipt atomically; contracts exist
  (`contracts/events/site-changed.v1.schema.json`, `bin-changed.v1.schema.json`, payload `bin_id, site_id, name, bin_version`); the transformer
  routes them to `greenguard.inventory.facility.v1` (`services/cdc-transformer/event.go:39-40`, README row); `scripts/kafka-topics.mjs`
  provisions the topic.
- VERIFIED: **nothing in the read path consumes them.** `services/projection-builder/consumer_kafka.go:21` subscribes only to `topicInventory`
  and `topicTelemetry`; `event.go:55` `eventTopics` lists only device and telemetry types; `replay.go:62` `replayTopics` likewise.
  `docs/STAGE_05_PLAN.md:262-263` plans `site_views` / `bin_views` with version guards on `site_version` / `bin_version`, but they were not built.
  MOBILE_DATA_AVAILABILITY.md item 13 says "see review H6: site/bin creation emits no events yet"; that note is stale (events now exist).
- Nuance 1: `services/search-indexer/search_indexer.py:172-190` indexes `bin.changed`/`site.changed` names into the `greenguard-inventory`
  search alias (`resource_type`, `resource_id`, `name`, `site_id`). That is an eventually consistent, optional text-search backend, keyed for
  search not lookup. Using it for alert rendering would make every alert screen depend on Elasticsearch/OpenSearch availability. Rejected.
- Nuance 2: `device-service` exposes no `GET` for sites or bins (`api/inventory.controller.ts` has `POST sites`, `POST bins`, `GET bins/:id/lots/at`,
  `GET devices`, `GET devices/:id`). A synchronous BFF call would need a new device-service route, put the OLTP write owner on the alert-read
  request path, and give the BFF a second read upstream with its own outage mode. Kept only as a documented fallback (section 7, R2).

**Chosen path for F6-F8: read-model projection (the Stage 05 plan's own design).** Consistent with the invariants: single write owner
(device-service), events via outbox, idempotent consumer with inbox, tenant RLS, reads through `read.*` views under the `read_query` role.

### 2.2 New read-DB objects (projection-builder, new migration `000016_facility_views.up.sql`; 000015 is the current last, VERIFIED)

```sql
CREATE TABLE site_views (
 tenant_id uuid NOT NULL, site_id uuid NOT NULL, name text NOT NULL, site_version bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (tenant_id, site_id));
CREATE TABLE bin_views (
 tenant_id uuid NOT NULL, bin_id uuid NOT NULL, site_id uuid NOT NULL, name text NOT NULL, bin_version bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (tenant_id, bin_id));
CREATE INDEX bin_views_site ON bin_views (tenant_id, site_id);
-- Same DO $$ loop as 000001: ENABLE + FORCE RLS, policy tenant_isolation on
-- tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid, USING and WITH CHECK.
CREATE VIEW read.site_views WITH (security_invoker=true, security_barrier=true) AS SELECT * FROM public.site_views;
CREATE VIEW read.bin_views  WITH (security_invoker=true, security_barrier=true) AS SELECT * FROM public.bin_views;
-- Grants mirror 000004/000006: projection_app writes the base tables (pattern of 000001's tail, UNVERIFIED which
-- grants it uses), read_query gets SELECT on read.* and on the base tables (security_invoker needs it).
```

- No foreign key from `bin_views` to `site_views`: facility events on one topic arrive per aggregate only, so a bin can precede its site
  (STAGE_05_PLAN "no cross-topic ordering assumed"). The join is at read time and `siteName` is null until the site event lands.
- Apply: `INSERT ... ON CONFLICT (tenant_id, bin_id) DO UPDATE SET ... WHERE bin_views.bin_version < EXCLUDED.bin_version` (version guard,
  concurrency choice = optimistic, documented in the migration header per AGENTS rule 3). Inbox row and checkpoint in the same transaction as
  the write (existing pattern in `processor.go`, UNVERIFIED in detail).
- Validation must include the H5 rule for the new types: `aggregate_id == payload.site_id` / `payload.bin_id` and
  `aggregate_version == payload.*_version` (fixtures already exist under `tests/fixtures/events/invalid/*-identity-mismatch.json`,
  `*-version-mismatch.json`).
- Backfill: sites and bins created before the consumer exists must be replayed from `greenguard.inventory.facility.v1`. Add the topic to
  `replayTopics` (`replay.go:62`). Whether the topic retention still holds the earliest events is UNVERIFIED (open question Q2).

### 2.3 Read API and read-model additions

- `packages/read-model/src/index.ts`: `getBins(tx, tenantId, binIds)`:
  `SELECT b.bin_id, b.name, b.site_id, s.name AS site_name, b.updated_at FROM read.bin_views b LEFT JOIN read.site_views s ON s.tenant_id=b.tenant_id AND s.site_id=b.site_id WHERE b.tenant_id=$1 AND b.bin_id = ANY($2::uuid[])`. Explicit tenant predicate on top of RLS, like every existing query (`index.test.ts:79` asserts this for all queries).
- `services/read-api/src/backends.ts`: `postgresReads.bins` via `withReadTenant`; add to the `ReadBackends` interface.
- `services/read-api/src/app.ts`: `POST /bins/batch` (mirror of `POST /devices/batch`, body `{binIds: uuid[]}`, 1..100, deduped, `invalid_ids` on violation), same role check as siblings (`viewer|operator|admin`, `app.ts:94`).
- `services/read-api/src/cache.ts` `cacheBackends`: wrap `bins` with the ADR-0015 tenant-scoped versioned key (kind `bins`, args = sorted ids), TTL 15 s + jitter, single-flight. No new key format, so `CACHE_KEY_VERSION` stays `v1`.
- `services/bff/src/read-client.ts`: `bins(authorization, ids)` mapping `bin_id, name, site_id, site_name, updated_at` to `{binId, name, siteId, siteName, projectedAt}`.

## 3. GraphQL schema, persisted operations, clients

### 3.1 SDL (edit in place in the `typeDefs` string in `services/bff/src/schema.ts`; additive only)

```graphql
"Score thresholds of the rule that produced the alert. Scores are 0-100 risk scores, not temperatures."
type AlertRule {
  ruleId: ID!
  ruleKey: String!
  resourceKind: String!
  "Alert opens when score >= openScore."
  openScore: Int!
  "Alert resolves when score < clearScore (always below openScore)."
  clearScore: Int!
  escalationTimeoutSeconds: Int!
}

"Facility context of the alert's bin. Names come from the read model and lag the source by the projection delay."
type AlertBin {
  binId: ID!
  name: String!
  siteId: ID!
  "Null until the site's own event is projected."
  siteName: String
  projectedAt: String
}

type AlertView {
  # existing fields unchanged: alertId ruleId binId state severity score version openWindowStart openedAt
  # acknowledgedAt acknowledgedBy resolvedAt escalationLevel
  "Null means not available (feature off, owner unreachable or row not visible), never 'no rule'."
  rule: AlertRule
  "Null means not available (not yet projected, feature off or read API unreachable)."
  bin: AlertBin
  "Null when never escalated or not available."
  escalatedAt: String
  "Grain at the time the alert opened. Null when unknown or not yet captured."
  grainType: String
}
```

Decisions:
- **No breaking change.** No existing field changes type, nullability or name. `binId` and `ruleId` stay, so old clients and the old persisted documents keep working.
- **No new enums.** `state`, `severity` are `String` today (`schema.ts`); turning them into enums would be a breaking type change for every client. `resourceKind` and `grainType` are open sets (grain pattern `^[a-z][a-z0-9_-]{0,31}$`, CHECK `resource_kind IN ('bin')` will widen), so a GraphQL enum would make each new value a client-visible breaking change. Clients must treat them as opaque strings with a fallback label. If the owner wants enums, do it in a later `AlertViewV2` type, not by mutation of this one (open question Q6).
- **Null means "not available", documented in field descriptions.** Rule and bin are separate nullable objects so a partial outage degrades one section only.
- **Deprecations: none now.** `ruleId`/`binId` remain the join keys. Do not deprecate `alertList`/`alertDetail` until both first-party clients ship the enriched documents and a usage window has passed (section 6).

### 3.2 New persisted operations (add to `operations` in `services/bff/src/query-policy.ts`; keep the two existing entries byte-identical)

```ts
alertListEnriched: `query AlertListEnriched($limit: Int!, $after: String, $state: String) { alerts(limit: $limit, after: $after, state: $state) { items { alertId ruleId binId state severity score version openWindowStart openedAt acknowledgedAt acknowledgedBy resolvedAt escalationLevel escalatedAt grainType rule { ruleKey resourceKind openScore clearScore escalationTimeoutSeconds } bin { name siteId siteName projectedAt } } nextCursor } }`,
alertDetailEnriched: `query AlertDetailEnriched($id: ID!) { alert(id: $id) { alertId ruleId binId state severity score version openWindowStart openedAt acknowledgedAt acknowledgedBy resolvedAt escalationLevel escalatedAt grainType rule { ruleId ruleKey resourceKind openScore clearScore escalationTimeoutSeconds } bin { binId name siteId siteName projectedAt } } }`,
```

Budget check against `assertQueryBudget` (depth <= 6, fields <= 40): list = 1 (`alerts`) + 1 (`items`) + 14 scalars + 1 + 5 (`rule`) + 1 + 4 (`bin`) + 1 (`nextCursor`) = 28 fields, depth 4. Detail = 1 + 15 + 1 + 6 + 1 + 5 = 29 fields, depth 3. Both are inside the budget; no fragments used (`fragments_not_allowed`).
The list document omits `rule.ruleId`/`bin.binId` (already selected as `ruleId`/`binId`); detail includes them so a detail screen is self-contained. Keep both fixed exactly once decided; any later edit is a new operation name.

Companion edits in the same change:
- `services/bff/src/rate-limit.ts:74`: add `alertListEnriched` to the cost-2 read list (`name === "alertList"` today). Without this the enriched list is charged cost 1. `hashes` is built from `operations` at `rate-limit.ts:49` so the name resolves automatically.
- `apps/mobile/src/alerts-client.ts` `operations`: add the two new strings byte-identical (test `alerts-client.test.ts:45` uses `source.includes(query)` against `query-policy.ts`).
- `apps/dashboard/src/alerts-api.ts` `operations.list`: this file holds its own copy of the list document. `apps/dashboard/src/read-api.test.ts:2` imports `operations` from the BFF to compare read documents; **UNVERIFIED** whether an equivalent test guards `alerts-api.ts`. Add one (test AD-C3).
- `scripts/browser-e2e.mjs:23` and `scripts/stage09b-machine-e2e.mjs:17` import `operations` from `services/bff/dist/query-policy.js`; they keep working unchanged.

### 3.3 How the allow-list is generated and versioned

There is no generated file. `persistedOperations` is `new Map(Object.values(operations).map(q => [sha256(q), q]))` computed at module load
(`query-policy.ts:22-24`, VERIFIED). The **operation name plus exact string is the version**. Rules:
1. Never edit an existing string in place (its hash is what deployed mobile builds send). Add a new key.
2. Retire an operation by deleting its key only after telemetry shows no traffic (add a counter `bff_persisted_operation_total{operation}`; there is currently none, UNVERIFIED) and the minimum supported mobile build has moved.
3. `query-policy.test.ts` asserts `persistedOperations.size === Object.keys(operations).length` (a duplicate string would fail it).

## 4. Authorization, isolation, caching, batching, errors, performance

**Authorization.** Reads: `viewer`, `operator`, `admin` (`AlertClient.list/get` call `requireRole`; workflow-alerts `READERS`; Read API `viewer|operator|admin`). No write is added. `acknowledgeAlert` (operator/admin) is unchanged. The new rule route uses `principalWith(req, READERS)`.

**Tenant isolation (defence in depth, no tenant in any payload).**
- Tenant comes only from the verified token: BFF `principal.tenantId`, workflow-alerts `TenantGuard` (`api/auth.ts`), Read API `res.locals.tenantId`. The new routes accept ids only, never a tenant.
- workflow-alerts: `findRules` runs inside `withTenant(db, tenantId, ...)`, SQL has an explicit `tenant_id = $1::uuid` on top of forced RLS (`alert_rules` policy `tenant_isolation`, VERIFIED) and uses `rule_id = ANY($2::uuid[])`.
- Read API: `getBins` explicit tenant predicate plus forced RLS on `bin_views`/`site_views` under `withReadTenant` (`set_config(..., true)` per transaction).
- ID-only selectors: a foreign or unknown id is simply absent from the result set (no 403 vs 404 distinction, no existence oracle). The BFF loader returns `null` for that id, so a foreign tenant's rule or bin can never appear even if an alert row referenced it.
- Cross-tenant negative tests are mandatory on every layer (section 5). Foreign keys keep alert rows consistent: `alert_episodes_rule_fkey` is composite on `(tenant_id, rule_id)` (VERIFIED), so an episode cannot point at another tenant's rule. There is no such constraint for `monitored_resource_id` (bin), which is why the bin lookup is tenant-filtered independently.
- No new tenant-scoped cache without a tenant key: ADR-0015 key `gg:read:v1:{t:<tenantId>}:g<gen>:<sha256(kind,args)>`, envelope `{t,k,v}` verified on read.

**Caching.**
- Alerts (workflow-alerts): not cached. State is mutable and acknowledge uses `If-Match`; the BFF has no alert cache today and none is added. Mobile keeps its per-tenant in-memory page cache (`alerts-client.ts`, key includes `tenantId`, cleared on acknowledge and sign-out); the enriched shape reuses the same key.
- Rules: per-request DataLoader only. No cross-request cache in the BFF (a process-wide cache keyed without tenant would be the exact old-system defect ADR-0015 exists to prevent; one keyed by tenant adds invalidation work for a table with a handful of rows per tenant).
- Bins/sites: Read API cache-aside per ADR-0015 (15 s TTL, +0-20% jitter, generation bump on invalidation, 256 KiB cap, fail-open to Postgres). Names change rarely; staleness bound is 18 s per ADR-0015 item 7. The invalidation caller for the read cache is still unbuilt (ADR-0015 "open work"), so TTL is the only bound.

**N+1 avoidance.**
- `AlertView.rule` and `AlertView.bin` are field resolvers backed by per-request `DataLoader`s created where `createDeviceLoader` is created (`services/bff/src/main.ts:179`). A page of up to 100 alerts issues at most: 1 alerts call, 1 `GET /v1/alert-rules?ids=` (deduped rule ids, batch <= 50, so a tenant with more distinct rules issues ceil(n/50) calls), 1 `POST /bins/batch` (deduped bin ids, `maxBatchSize: 100`, matching the existing device loader). The two enrichment calls run in parallel after the alerts call. Worst case is 3 sequential-ish upstream round trips independent of page size, versus 200 without batching.
- The resolvers must not run when the document does not select `rule`/`bin` (GraphQL guarantees this), so old `alertList` clients pay nothing.

**Pagination.** Unchanged: BFF `limit` 1-100, opaque `after` = last alert id, `nextCursor`; owner caps 200 (`api/parse.ts`). Rule ids per page are bounded by the page size, so the rule batch is bounded. The known ordering gap (episode_id keyset, not severity/age) is not changed here (MOBILE_DATA_AVAILABILITY item 26 note; dashboard sorts client-side).

**Error model.**
- Core alert failures keep their current codes: `invalid_alert_page`, `invalid_alert_id`, `invalid_alert_command` (400), `alert_unavailable`, `alerts_api_unavailable` (503), `upstream_unavailable` (503) via `translate()` in `schema.ts`. No change.
- Enrichment failures never fail the alert query. Resolver catches `AlertUpstreamError` / `ReadUpstreamError` / timeout and returns `null`, logs at warn with the operation and field but no tenant on metric labels, and increments `bff_alert_enrichment_total{field="rule"|"bin", outcome="ok"|"missing"|"error"|"disabled"}` (no tenant or device labels, review Q1). Rationale: an operator must still be able to acknowledge an alert when the read DB is down (live evidence: Read API was down while alerts worked).
- Owner route errors (RFC 7807 as elsewhere in workflow-alerts): 400 `invalid ids` (not uuid, empty, > 50), 401/403 auth and role, 503 unavailable.
- Clients: `null` `rule`/`bin` renders the fallback (`Rule <short id>`, `Bin <short id>`), never an error banner.

**Performance budget (targets, UNMEASURED; do not report them as results).**
- Enrichment adds at most 2 parallel upstream calls per request regardless of page size; per-call timeout 2 s (below the 8 s `AlertClient` timeout so a slow read API cannot delay the core answer by more than 2 s); added latency target p95 <= 50 ms warm cache, <= 150 ms cold on the local stack.
- Read API `bins/batch` is a primary-key lookup (`(tenant_id, bin_id)`) plus a join on `(tenant_id, site_id)`; expected index-only, to be confirmed with `EXPLAIN` in test AD-R4.
- Tier 1 stage 13 API target is p95 < 300 ms (`IMPLEMENTATION_BACKLOG.md` stage 13); the enriched list must be included in that k6 matrix.
- Rate limit cost: enriched list = 2 (same as `alertList`), detail = 1.

## 5. Test-first plan

Numbering: `AD-<layer><n>`. For each, write the failing test first and watch it fail for the stated reason, then implement.
Layers: U = BFF unit/resolver, C = contract/persisted operation and client copies, W = workflow-alerts route, P = projection-builder, R = read-model/Read API, X = cross-tenant, M = mobile client, D = dashboard.

| ID | Layer | First failing test | Extend this file |
| --- | --- | --- | --- |
| AD-C1 | contract | `operations.alertListEnriched` and `alertDetailEnriched` exist; each hash is in `persistedOperations`; `resolvePersistedOperation` accepts them; `assertQueryBudget(parse(...))` does not throw; old `alertList`/`alertDetail` strings and hashes are unchanged (pin the two old hashes as literals) | `services/bff/src/query-policy.test.ts` |
| AD-C2 | contract | `operationCharge` returns `{group:"read", cost:2}` for `alertListEnriched` and cost 1 for `alertDetailEnriched` | `services/bff/src/rate-limit.test.ts` |
| AD-C3 | contract | dashboard `alerts-api.ts` list document equals `operations.alertListEnriched` from the BFF (mirror of `read-api.test.ts:2`) | new `apps/dashboard/src/alerts-api.test.ts` (or extend `AlertsView.test.tsx`) |
| AD-U1 | unit | GraphQL `alertListEnriched` returns `resolvedAt`, `openWindowStart`, `acknowledgedBy` mapped from the owner page (fails today because the document does not exist; covers Phase A) | `services/bff/src/alerts.test.ts` (near the existing "GraphQL alert page maps owner data" test at line 143) |
| AD-U2 | unit | 30 alerts sharing 3 rules and 4 bins produce exactly one `alert-rules` fetch and one `bins/batch` fetch (assert fetch call counts) | `services/bff/src/alerts.test.ts` |
| AD-U3 | unit | read API 503 makes `bin` null while `alertId` and `state` still return and `errors` is absent; same for the rule route | `services/bff/src/alerts.test.ts` |
| AD-U4 | unit | with `BFF_ALERT_RULE_ENRICHMENT` / `BFF_ALERT_BIN_ENRICHMENT` off, no upstream call is made and the field is null | `services/bff/src/alerts.test.ts` |
| AD-U5 | unit | owner returns a rule id not in the rules response, so `rule` is null, not an error | `services/bff/src/alerts.test.ts` |
| AD-W1 | owner route | `GET /v1/alert-rules?ids=` returns `ruleKey, resourceKind, openScore, clearScore, escalationTimeoutSeconds` for the tenant's seeded default rule | `services/workflow-alerts/src/api/api.test.ts` (uses `src/testing/api.ts`, `fixtures.ts`) |
| AD-W2 | owner route | invalid or empty or > 50 ids returns 400; no token 401; role outside READERS 403 | `services/workflow-alerts/src/api/api.test.ts`, `unit.test.ts` |
| AD-W3 | owner route | `escalatedAt` is present in list and get after an escalation, null before | `services/workflow-alerts/src/api/api.test.ts`, `unit.test.ts` (`toAlertDto`) |
| AD-W4 | owner route | Phase 3: an opening `risk.assessed` with `grain_type` stores it on the episode; duplicate and replay keep it; absent leaves null | `services/workflow-alerts/src/consumer/handler.test.ts`, `migrations.test.ts` |
| AD-X1 | cross-tenant | tenant B asks `GET /v1/alert-rules?ids=<A's rule id>` and gets an empty list, never A's row | `services/workflow-alerts/src/api/api.test.ts` next to "tenant B cannot list, read or acknowledge" (line 102) |
| AD-X2 | cross-tenant | SQL layer: `alerts_app` with B's context selecting A's `alert_rules` row sees nothing | `services/workflow-alerts/src/api/api.test.ts` "row-level security at the SQL layer" (line 164) |
| AD-X3 | cross-tenant | read-model `getBins` with tenant B and A's bin id returns []; bins in `bin_views` need the tenant predicate (extend the "all read queries include an explicit tenant predicate" scan) | `packages/read-model/src/index.test.ts` (line 79), live variant beside line 111 |
| AD-X4 | cross-tenant | Read API `POST /bins/batch` as tenant B with A's bin ids returns no rows; cached response for A is never served to B (ADR-0015 envelope mismatch) | `services/read-api/src/app.test.ts`, `cache.test.ts` |
| AD-X5 | cross-tenant | BFF end to end: tenant B's alert never renders tenant A's rule or bin even if the read API mock returned them (loader filters by requested id) | `services/bff/src/alerts.test.ts` |
| AD-P1 | projection | `bin.changed` v1 upserts `bin_views`; `site.changed` upserts `site_views`; a stale `bin_version` is ignored; duplicate event id is a no-op via inbox; bin before site leaves `site_name` null then fills | `services/projection-builder/processor_test.go`, `db_test.go`, `read_views_test.go` |
| AD-P2 | projection | H5: `aggregate_id != payload.bin_id` and version mismatch are quarantined; fixtures in `tests/fixtures/events/invalid/*` | `services/projection-builder/processor_test.go` (event validation) |
| AD-P3 | projection | replay of the facility topic rebuilds the same rows (`replayTopics` includes it); RLS forced on both tables; `read_query` can SELECT `read.bin_views` but not write | `services/projection-builder/replay_test.go`, `replay_db_test.go`, `migrate_test.go` |
| AD-R1 | read-model | `getBins` joins site name, returns null `site_name` when the site row is absent, and honours `ANY($2::uuid[])` | `packages/read-model/src/index.test.ts` |
| AD-R2 | Read API | `POST /bins/batch` validates 1..100 uuids, dedupes, maps `invalid_ids` | `services/read-api/src/app.test.ts` |
| AD-R3 | Read API | second identical batch is a cache hit (`hit` counter) and a generation bump forces a miss | `services/read-api/src/cache.test.ts` |
| AD-R4 | read-model | `EXPLAIN` of the batch query uses the primary key for `bin_views` (live DB) | live test beside `index.test.ts:111` |
| AD-M1 | mobile | `AlertsClient.list` sends `alertListEnriched`, returns `rule`, `bin`, `resolvedAt`; clearing cache on identity change still applies | `apps/mobile/src/alerts-client.test.ts` (extend "list sends persisted-query hash..." at line 54) |
| AD-M2 | mobile | new `operations` strings appear byte-for-byte in `query-policy.ts` (existing test at line 45 iterates all keys, so it fails until the copy is added) | `apps/mobile/src/alerts-client.test.ts` |
| AD-M3 | mobile | a response with `bin: null, rule: null` yields a typed page without throwing | `apps/mobile/src/alerts-client.test.ts` |
| AD-D1 | dashboard | `AlertsView` shows bin name, site name and rule key with thresholds when present, and `Bin <short id>` fallback when `bin` is null | `apps/dashboard/src/AlertsView.test.tsx` |
| AD-D2 | dashboard | list renders `resolvedAt` for resolved alerts and does not call the removed old document | `apps/dashboard/src/AlertsView.test.tsx`, `alerts-api` test |
| AD-E1 | live e2e | seeded two-tenant stack: alice's alert shows the real bin name and rule key; bob's does not see them | extend `scripts/browser-e2e.mjs` and add a step in `scripts/stage06-e2e.mjs` style (paths verified to exist) |

Acceptance for the whole feature: `make verify`, `make coverage` (80% gate, 0 duplication) and local Sonar per `CLAUDE.md`; cross-tenant tests AD-X1..X5 all green.

## 6. Rollout and compatibility

- **Single version of the persisted operations.** Ship the final documents once (`alertListEnriched`, `alertDetailEnriched`) and back the fields in phases, because editing a document later changes its hash and forces another client release. Fields not yet backed return `null` (documented semantics), so clients render fallbacks from day one.
- **Feature flags (BFF env, default off in prod until verified):** `BFF_ALERT_RULE_ENRICHMENT`, `BFF_ALERT_BIN_ENRICHMENT` (read in `main.ts` next to `ALERT_API_URL`/`READ_API_URL`, passed into the context). Off means the resolver returns null with no upstream call. This also lets the BFF deploy before workflow-alerts or the read model.
- **Old clients keep working.** `alertList` and `alertDetail` stay allow-listed and byte-identical. The schema change is additive, so their documents still validate.
- **Deploy order:** (1) projection-builder migration and consumer, replay/backfill, verify counts; (2) read-model and read-api route; (3) workflow-alerts route and `escalatedAt`; (4) BFF schema, loaders, operations, rate-limit names, flags on; (5) mobile and dashboard releases; (6) after telemetry shows old operations idle, retire them.
- **Migrations are forward-only** (review O5): `000016` only creates tables/views; a bad deploy is fixed by a new migration. The optional Phase 3 column `alert_episodes.grain_type` is likewise additive and nullable, with `GRANT UPDATE ("grain_type") ... TO alerts_app` following the pattern of `20260924110000_assessment_invalidation`.
- **Evidence:** per `AGENTS.md` rule 4 save live results under `evidence/` before touching `docs/MILESTONES.md`. Also add a new ADR (next free number is 0023; note two files already share 0018) because this adds a read-model projection and a new cross-service read path.

### Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | Facility projection is new consumer work in Stage 05 territory; unordered arrival leaves `siteName` temporarily null | Nullable `siteName`, version guard, no FK, tests AD-P1 |
| R2 | If the projection cannot land soon, names stay unavailable | Fallback: a device-service `GET /v1/bins/:id` behind the BFF flag. Costs a new route on the write owner and an OLTP read on the alert path; only as a bridge, with its own ADR |
| R3 | Facility topic retention may not cover old bins, so old alerts show no name | Q2; replay plus, if needed, a one-off device-service re-emit of `bin.changed` for existing rows (an owner-side operation, not a cross-DB read) |
| R4 | `openScore`/`clearScore` misread as temperature limits | Field descriptions and UI copy say "score" |
| R5 | Two enrichment calls add latency and a failure mode | Parallel, 2 s timeouts, fail to null, metrics, flags |
| R6 | Dashboard's copy of the document drifts | Test AD-C3 |
| R7 | The projection and the alert episode disagree on the bin after a rename | Names are display-only; ids remain authoritative |
| R8 | Metric label cardinality | No tenant, bin or rule ids as labels (review Q1) |

## 7. Open questions for the owner

1. Metrics: confirm no tenant/bin/rule labels on `bff_alert_enrichment_total` (matches review Q1 rule).
2. Facility topic retention: is `greenguard.inventory.facility.v1` (and `greenguard.raw.inventory.outbox`) retained long enough to backfill every existing bin and site, or do we need an owner-side re-emit? UNVERIFIED.
3. Grain type (F13): approve snapshot-at-open in `alert_episodes.grain_type` from `risk.assessed`? This changes workflow-alerts schema, consumer and possibly `alert-lifecycle.v1` payload (UNVERIFIED whether the lifecycle schema carries it). Or defer F13 entirely?
4. Rule route shape: `GET /v1/alert-rules?ids=` (recommended, batchable) versus embedding a `rule` object in the alert DTO (fewer routes but touches the lifecycle read shape).
5. Read-model ownership: is adding facility projection to projection-builder acceptable now, given Stage 05 status and concurrent Stage 07/09 work, or should it wait for a Stage 05 slice? A Stage 05 milestone row would need the linked evidence.
6. Enum policy: keep `String` for state, severity, resourceKind and grainType (recommended), or plan a versioned `AlertViewV2` with enums?
7. Acknowledger display name: separate ticket against `tenant-control-plane`?
8. Should enrichment failures surface to clients as a machine-readable partial (`extensions`) rather than a bare null? Recommended: no, keep null plus metrics.

## 8. Implementation tasks (ordered, one implementer each)

Ownership warning: tasks 4 and 8 touch `services/workflow-alerts`. Per the coordination rule the Codex session owns `services/workflow-alerts` and `services/jobs-worker`; **it must agree before those tasks start**. No task here touches `services/jobs-worker`. Task 5 touches `services/projection-builder`, which has concurrent Stage 05/07 activity in the working tree; check `git status` for conflicts first (UNVERIFIED who owns it).

| # | Task | Owns (files) | Depends | Tests first |
| --- | --- | --- | --- | --- |
| 1 | Phase A, no owner change: add `alertListEnriched`/`alertDetailEnriched` documents selecting `resolvedAt`, `openWindowStart`, `acknowledgedBy` (rule/bin/escalatedAt/grainType selected too but resolved null behind flags), SDL additions, null resolvers, rate-limit names, flags | `services/bff/src/query-policy.ts`, `schema.ts`, `rate-limit.ts`, `main.ts`, `query-policy.test.ts`, `rate-limit.test.ts`, `alerts.test.ts` | none | AD-C1, AD-C2, AD-U1, AD-U4 |
| 2 | Mobile client copy and types, fallbacks | `apps/mobile/src/alerts-client.ts`, `alerts-client.test.ts` | 1 | AD-M1..M3 |
| 3 | Dashboard document, types and rendering (bin/site/rule/thresholds/resolvedAt) | `apps/dashboard/src/alerts-api.ts`, `AlertsView.tsx`, `AlertSummary.tsx`, tests | 1 | AD-C3, AD-D1, AD-D2 |
| 4 | **[workflow-alerts, needs Codex agreement]** `findRules` + `GET /v1/alert-rules?ids=` and `escalatedAt` in `toAlertDto`; cross-tenant tests | `services/workflow-alerts/src/alerts/store.ts`, `api/alerts.controller.ts`, `api/parse.ts`, `api/api.test.ts`, `api/unit.test.ts` | none | AD-W1..W3, AD-X1, AD-X2 |
| 5 | **[projection-builder]** migration `000016_facility_views`, facility consumer, validation (H5), replay topic, tests, backfill runbook | `services/projection-builder/migrations/000016_*`, `consumer_kafka.go`, `event.go`, `processor.go`, `replay.go`, tests | none (parallel with 4) | AD-P1..P3 |
| 6 | Read model and Read API `bins/batch` with ADR-0015 caching | `packages/read-model/src/index.ts`, `services/read-api/src/backends.ts`, `app.ts`, `cache.ts`, tests | 5 | AD-R1..R4, AD-X3, AD-X4 |
| 7 | BFF loaders and resolvers: `AlertClient.rules()`, `ReadClient.bins()`, `rule`/`bin` field resolvers, DataLoaders, enrichment metrics, flags honoured | `services/bff/src/alerts.ts`, `read-client.ts`, new `alert-loaders.ts`, `schema.ts`, `main.ts`, tests | 1, 4, 6 | AD-U2, AD-U3, AD-U5, AD-X5 |
| 8 | **[workflow-alerts, needs Codex agreement; only if Q3 approved]** `alert_episodes.grain_type` migration, consumer capture, DTO, BFF `grainType` | `services/workflow-alerts/prisma/migrations/*`, `consumer/handler.ts`, `alerts/store.ts`, `api/parse.ts`, tests | 4 | AD-W4 |
| 9 | ADR-0023 (facility projection and enriched alert read path), docs update (`MOBILE_DATA_AVAILABILITY.md` rows 6, 8, 10, 13, 14, 19), live evidence, e2e step | `docs/adr/0023-*.md`, `docs/MOBILE_DATA_AVAILABILITY.md`, `evidence/`, `scripts/browser-e2e.mjs` | 1-7 | AD-E1 |

Tasks 1-3 deliver F9, F10, F12 immediately with zero backend risk. Tasks 4 and 7 deliver F1-F5 and F11. Tasks 5-7 deliver F6-F8. Task 8 delivers F13 if approved.
