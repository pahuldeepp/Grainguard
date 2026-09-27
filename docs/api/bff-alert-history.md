# Design: `alertHistory` (real alert lifecycle history through the BFF)

Status: PROPOSED design, 2026-09-26. Nothing in this document is implemented. Author checked source, the local
`greenguard_alerts` and `greenguard_control` databases (read-only selects, no data printed beyond counts and
shapes) and the existing docs. Items marked **(unverified)** were not proven.

**Ownership warning.** `services/workflow-alerts/**` is being edited by another owner (the Codex session). Tasks
T1 to T3 below touch it and need that owner's agreement before any edit. Everything else (BFF, dashboard, mobile,
docs) is outside that service.

## 0. Summary and decisions

1. The authoritative history already exists: `alert_transitions` in `greenguard_alerts`, append-only, forced RLS,
   written in the same transaction as every episode change and its outbox event (`recordTransition`,
   `recordSuppressedEscalation` in `services/workflow-alerts/src/alerts/store.ts`). No route reads it.
2. Add one read-only route in workflow-alerts, `GET /v1/alerts/:id/transitions`, and one persisted BFF query,
   `alertHistory`. The BFF stays a pass-through; it does not read the alerts database (one data owner per service).
3. "Who" is honest and privacy-safe: a transition has `actor.kind` (`system` or `user`), `actor.isYou` and a
   non-reversible per-tenant `actor.handle`. The raw Dex subject never reaches a client through the new query.
   **No display name or email exists anywhere in the platform for another user** (section 1.4), so v1 cannot show
   names for colleagues. That is a stated limitation, with a follow-up path (open question Q1), not something to fake.
4. Old mobile and dashboard builds keep working because persisted operations are hash-keyed: existing operation
   strings are frozen, new strings are added as new entries (section 3).
5. No new cache. Alert history is mutable and the alert path has no cache (ADR-0015 covers the Read API only).

## 1. Fields and their sources

### 1.1 Verified source: `alert_transitions` (migration `20260924100000_alert_lifecycle`)

| Column | Type | Meaning, as written by code |
| --- | --- | --- |
| `tenant_id` | uuid | RLS key; part of the PK `(tenant_id, transition_id)` |
| `transition_id` | uuid | Equals `event_id` for event-backed rows: `deterministicId(tenant, episode, version, type)` (`store.ts recordTransition`). Deterministic, so replays converge. Its order is random (a hash), so it is a tiebreaker only. |
| `episode_id` | uuid | The alert id. FK to `alert_episodes`. |
| `episode_version` | bigint | Episode version after the transition. +1 per emitted lifecycle event. |
| `transition_type` | text | CHECK: `opened, updated, acknowledged, escalated, resolved, escalation_suppressed` |
| `from_state` / `to_state` | text | `open, acknowledged, resolved`; `from_state` NULL only for `opened` |
| `actor_type` | text | CHECK `system` or `user` |
| `actor_id` | text | `user`: the token `sub` of the acknowledger (`alerts.controller.ts` passes `principal.subject`). `system`: the literal `workflow-alerts` (`SYSTEM` in `lifecycle.ts`; live values confirmed). |
| `cause_id` | uuid NOT NULL | See 1.2. |
| `event_id` | uuid NULL | The lifecycle outbox event. NULL exactly for `escalation_suppressed` (CHECK). |
| `occurred_at` | timestamptz(6) | The transaction's `now`. |

Index: `alert_transitions_episode_idx (tenant_id, episode_id, episode_version)`. Runtime role `alerts_app` has
SELECT and INSERT only (confirmed live). RLS enabled and forced (confirmed live).

### 1.2 What `cause_id` really is (verified in `lifecycle.ts`)

| Transition | `cause_id` is | Expose as |
| --- | --- | --- |
| `opened`, `updated`, `resolved` | the source risk event id (`input.eventId`) | `cause.kind = "risk_event"`, `cause.id` = that id |
| `acknowledged` | a random `commandId` (`randomUUID()`), the acknowledge command | `cause.kind = "command"`, `cause.id` = command id |
| `escalated`, `escalation_suppressed` | synthetic `deterministicId(episode, version, "escalation-check")`, not a real event | `cause.kind = "escalation_check"`, `cause.id = null` |

The mapping is a pure function of `transition_type`, so no schema change is needed. The UI should not display cause
ids; they are for support and tracing (`eventId` also goes into logs and traces).

### 1.3 Live shape (read-only, 2026-09-26, local dev database)

- 4,853 transition rows, 2,610 tenants, max 4 rows per episode.
- Types: opened 2,871; updated 427; escalated 430; acknowledged 530; resolved 337; escalation_suppressed 258.
- `actor_type=user` only on `acknowledged`; every other row is `system` / `workflow-alerts`. User subjects vary in
  length (4, 10, 16, 26 characters): they are opaque, not display names.
- For all 530 acknowledged rows, `actor_id` equals `alert_episodes.acknowledged_by` for that episode: the two agree.
- Every escalated row's `occurred_at` equals `alert_episodes.escalated_at` (430 of 430): `escalatedAt` is derivable
  either way.

Ordering findings that shape the design:

1. **`episode_version` is not unique per episode.** 258 `(tenant, episode, version)` groups have 2 rows:
   `escalation_suppressed` reuses the version of the row it observes (`recordSuppressedEscalation`). Ordering by
   version alone is therefore a partial order.
2. **`occurred_at` can disagree with version.** 86 episodes show `escalated@2` with an `occurred_at` later than the
   `acknowledged@3` that followed it. The escalation step takes an injectable `now`
   (`escalateIfStillUnacknowledged(db, episode, now = new Date(), ...)`), so this is most likely a test or sweep
   harness clock **(unverified: cause not traced)**. Consequence: version, not time, is the ordering authority.
3. **History is not guaranteed complete.** 95 of 2,966 episodes have zero transition rows (all `open`, version 1),
   and 88 episodes have `alert_episodes.version` different from the max transition version. Likely seeded or
   pre-audit rows **(unverified)**. The API must report completeness rather than assume it.

**Ordering guarantee to document and test:** items are sorted by `(episode_version ASC, occurred_at ASC,
transition_id ASC)`. Within one version the only possible tie is a suppressed no-op after the real transition, and
`occurred_at` breaks it. The same key is the pagination cursor. Clients must not re-sort by time and must render
`occurredAt` as-is (it may not be monotonic across versions).

### 1.4 What "who" can honestly mean

| Case | Stored | Shown |
| --- | --- | --- |
| Risk engine opened, updated or resolved it | `system` / `workflow-alerts` | "Automatic (risk engine)" |
| Escalation worker | `system` / `workflow-alerts` | "Automatic escalation" |
| A person acknowledged, and that person is the current caller | `user` / subject equals session subject | "You" |
| A person acknowledged, someone else in the same tenant | `user` / other subject | "Team member 3F2A" (handle) |

Identity facts (verified):

- Alert rows keep only the token `sub`. Not the issuer, not an identity id, not an email, not a name.
- `tenant-control-plane` (ADR-0017) stores `identities(identity_id, issuer, subject)` and
  `memberships(tenant_id, identity_id, role, state, ...)`. It stores **no display name and no email**; the only
  email-derived value is `invitations.email_hash` (SHA-256, one-way, not reversible, not joinable to a name).
  `GET /organizations/:tenantId/members` returns `identityId, issuer, subject, role, state, ...`, so a membership
  lookup would return another opaque subject, not a name.
- The token carries `email`/`email_verified` (`@greenguard/tenant-auth` `Principal`), so the platform can show the
  caller their own email, but nothing can resolve someone else's.
- The membership lookup could give a **role** for a subject, but that is not requested and not needed.

Therefore v1 identity strategy:

1. **Never return a raw subject in any new field.** Compute in workflow-alerts, where the verified principal is
   available (`req.principal.subject`), and return only `actor.kind`, `actor.isYou` and `actor.handle`.
2. `isYou = (actor_type = 'user' AND actor_id = principal.subject)`. Comparison is server-side, so clients never
   need the raw subject to decide.
3. `handle` = first 4 hex characters, uppercased, of `sha256("alert-actor\n" + tenantId + "\n" + actor_id)`.
   Stable within a tenant (the same colleague gets the same handle on every alert), different in another tenant,
   not reversible. 16 bits is a display disambiguator only, not an identifier. `null` for `system`.
4. **Display name lookup is not done in v1.** It would need a new data element that does not exist (Q1). If later
   approved, the seam is: BFF resolver maps `handle`-bearing actors to names via a tenant-scoped
   control-plane lookup, never crossing tenants, gated by the privacy decision in Q1.
5. Known limitation: rows store `sub` without issuer, so two issuers with the same `sub` inside one tenant would
   both read as "You" for one caller. ADR-0014 and ADR-0017 key identity by `iss|sub`. Multiple issuers per
   tenant are possible with the multi-issuer verifier **(unverified for the alert path)**. Mitigation: Q2.
6. Existing exposure to fix: `AlertView.acknowledgedBy` (`schema.ts`, `toAlertDto`, the `alertDetail` operation and
   `apps/mobile/src/alerts-client.ts`) returns the raw subject. It is same-tenant only, so it is a
   privacy-hygiene defect, not a cross-tenant leak. Fix in the BFF resolver without changing the operation text
   (section 3.3).
7. Erasure caveat (review O2): raw subjects persist in append-only `alert_transitions`, `alert_episodes` and the
   outbox and cannot be deleted by the runtime role. This design neither worsens nor solves it; a later change to
   store `identity_id` (a deterministic pseudonym) instead of `sub` would solve both Q2 and O2. Not in scope.

### 1.5 Response fields

Per item (all from `alert_transitions` unless noted):

| Field | Source | Notes |
| --- | --- | --- |
| `transitionId` | `transition_id` | stable, deterministic |
| `version` | `episode_version` (string, like the existing `version`) | bigint as string |
| `type` | `transition_type` | `escalation_suppressed` only with `include=all` |
| `fromState`, `toState` | `from_state`, `to_state` | `fromState` null for opened |
| `occurredAt` | `occurred_at` ISO 8601 UTC, ms precision as the DTOs do today | see 1.3 for ordering |
| `actor` | `actor_type`, computed `isYou`, `handle` | 1.4 |
| `cause` | `cause_id` plus type rule | 1.2 |
| `eventId` | `event_id` | null only for suppressed |

Page level: `alertId`, `items[]`, `nextCursor`, `complete` (boolean: an `opened` row exists and the maximum
transition version equals `alert_episodes.version`; computed from one indexed aggregate on the first page).

Not included, deliberately: score and severity per transition. They are not columns of `alert_transitions`; they
exist only in the outbox `payload` (`score`, `severity`, `escalation_level`, `source_event_id`). Joining
`outbox_events` is possible (same DB, RLS, insert-only) but outbox retention is not defined **(unverified)**; if it
is later purged, history would silently lose fields. Recommended follow-up (P2 in `ARCHITECTURE_REVIEW.md`, the
event-sourced alert lifecycle idea): add nullable `score`, `severity` and `escalation_level` columns to
`alert_transitions` in a forward-only migration. Not required for the four asked-for facts.

Escalation and acknowledgement data on the alert itself (`escalatedAt`, `resolvedAt`, `openWindowStart`): section 3.2.

## 2. workflow-alerts route (NEEDS CODEX-OWNER AGREEMENT)

### 2.1 Contract

```
GET /v1/alerts/:id/transitions?limit=50&after=<cursor>&include=lifecycle|all
Authorization: Bearer <token>      # same TenantGuard as the rest of AlertsController
Roles: viewer, operator, admin     # READERS; device tokens get 403 via requireRole
200 { "alertId": "...", "complete": true,
      "items": [ {transitionId, version, type, fromState, toState, occurredAt,
                  actor:{kind, isYou, handle}, cause:{kind, id}, eventId} ],
      "nextCursor": "<opaque>" | null }
Headers: Cache-Control: private, no-store; ETag: "<alert episode version>" (default view only)
400 invalid_input (bad limit/after/include)   404 alert_not_found   401/403 as elsewhere
```

- `limit` 1 to 100, default 50 (the existing list allows up to 200; history rows are small but 100 matches the BFF
  cap `AlertClient.list`).
- `include=lifecycle` (default) excludes `escalation_suppressed`, an internal no-op receipt with no event and no user
  meaning. `include=all` is for support tooling and is not selected by any persisted operation.
- `after` is an opaque base64url JSON cursor `{v, t, id}` = `(episode_version, occurred_at as microsecond ISO,
  transition_id)`, strictly validated like the control-plane member cursor (`store.ts listMembersPage`). Invalid
  cursors return 400, never a partial scan.
- `:id` must pass `isUuid`, else 404 (existing helper `alertId()`), so malformed and unknown look alike.

### 2.2 Query (inside `withTenant`, RLS plus explicit filter, same style as `listEpisodes`)

```sql
-- first: 404 unless the episode is visible to this tenant (readEpisode already exists)
SELECT transition_id, episode_version, transition_type, from_state, to_state,
       actor_type, actor_id, cause_id, event_id, occurred_at
  FROM alert_transitions
 WHERE tenant_id = $tenant::uuid AND episode_id = $id::uuid
   AND ($all OR transition_type <> 'escalation_suppressed')
   AND (episode_version, occurred_at, transition_id) > ($v, $t, $tid)   -- omitted on page one
 ORDER BY episode_version, occurred_at, transition_id
 LIMIT $limit + 1;                                                     -- extra row decides nextCursor
```

The `limit + 1` read fixes a defect of the existing list (`items.length === request.limit` yields a non-null cursor
on an exactly-full last page). The `(tenant_id, episode_id, episode_version)` index serves the prefix. No new index
or migration is needed. **Raw `actor_id` leaves the SQL layer only to compute `isYou` and `handle` in the mapper; it
is never placed in the DTO.**

### 2.3 Files (workflow-alerts, all additive)

| File | Change |
| --- | --- |
| `src/alerts/store.ts` | new `listTransitions(tx, tenantId, episodeId, page)` and `transitionSummary(tx, tenantId, episodeId)` |
| `src/api/parse.ts` | `transitionPage(limit, after, include)` validator, cursor codec, `toTransitionDto(row, principal)` (actor mapping, cause mapping) |
| `src/api/alerts.controller.ts` | new `@Get(":id/transitions")`; must be declared so it does not shadow `@Get(":id")` (Nest matches by path segments, different depth, no conflict) |
| `src/api/toAlertDto` in `parse.ts` | additive `escalatedAt` (needs `escalated_at`, already selected by `SELECT *` and in `EpisodeRow`) |
| tests | `src/api/api.test.ts`, `src/api/unit.test.ts` |

If the owner prefers not to grow the controller, an equivalent `AlertTransitionsController` in a new file is fine.

### 2.4 Alternatives considered

| Option | Verdict |
| --- | --- |
| A. New workflow-alerts route (this design) | Chosen. Authoritative, transactional, RLS-protected, minimal latency, no new store. |
| B. BFF reads `greenguard_alerts` directly | Rejected: breaks one-owner-per-database and gives the BFF a second DB credential. |
| C. Project lifecycle events (`greenguard.alerts.lifecycle.v1`) into the Read API / read DB | Sound long term (review H6 says alert projection is a Stage 06 item) but adds a projection, replay, lag and a freshness gate; heavier than the need, and lags acknowledgements the user just made. Revisit only if history volume or cross-alert queries (audit feed) demand it. |
| D. Event-sourced fold from `outbox_events` | Rejected: outbox retention undefined **(unverified)**, payload is not an audit contract. P2 (event-sourced alert lifecycle) can be delivered by a future dedicated aggregate; it is not a prerequisite here. |
| E. Add history to `GET /v1/alerts/:id` | Rejected: unbounded response, couples list/detail latency to history size. |

## 3. GraphQL SDL and persisted operations (BFF)

### 3.1 New SDL (`services/bff/src/schema.ts`; existing style uses `String` for enums and versions)

```graphql
type AlertActor { kind: String!, isYou: Boolean!, handle: String }
type AlertCause { kind: String!, id: ID }
type AlertTransition {
  transitionId: ID!
  version: String!
  type: String!
  fromState: String
  toState: String!
  occurredAt: String!
  actor: AlertActor!
  cause: AlertCause!
  eventId: ID
}
type AlertHistoryPage { alertId: ID!, items: [AlertTransition!]!, nextCursor: String, complete: Boolean! }

extend type Query {                       # i.e. inside type Query
  alertHistory(id: ID!, limit: Int!, after: String): AlertHistoryPage!
}
```

Also add to `AlertView`: `escalatedAt: String` (nullable). Additive schema changes are safe for old clients.

### 3.2 New persisted operations (`services/bff/src/query-policy.ts`, `operations` map)

```ts
alertHistory: `query AlertHistory($id: ID!, $limit: Int!, $after: String) { alertHistory(id: $id, limit: $limit, after: $after) { alertId complete nextCursor items { transitionId version type fromState toState occurredAt actor { kind isYou handle } cause { kind id } eventId } } }`,
alertDetailV2: `query AlertDetailV2($id: ID!) { alert(id: $id) { alertId ruleId binId state severity score version openWindowStart openedAt acknowledgedAt escalationLevel escalatedAt resolvedAt } }`,
```

Budget check against `assertQueryBudget` (depth <= 6, fields <= 40): `alertHistory` has depth 4 and 19 selected
fields (alertHistory, alertId, complete, nextCursor, items, transitionId, version, type, fromState, toState,
occurredAt, actor, kind, isYou, handle, cause, kind, id, eventId; hand-counted, AH-B01 verifies). No fragments.
`alertDetailV2` deliberately omits `acknowledgedBy`: the acknowledger is read from history (`type = acknowledged`,
`actor.isYou`), so the raw subject is not needed by new clients.

### 3.3 Keeping old builds working

The allowlist key is `sha256(operation string)` (`operationHash`). Changing any existing string changes its hash
and old builds get `operation_not_allowed`. Therefore:

1. **Never edit** existing entries `alertList`, `alertDetail`, `acknowledgeAlert`. Add new names only.
2. Add a frozen-hash test (AH-B02) with the current SHA-256 of every shipped operation; a diff must be a deliberate
   deprecation, not an accident.
3. The existing mobile test "operations match the BFF persisted-query allowlist text"
   (`apps/mobile/src/alerts-client.test.ts`) keeps guarding drift for the strings the mobile client actually uses.
4. New clients use `alertDetailV2` and `alertHistory`. Old clients keep `alertDetail` (still returns
   `acknowledgedBy`).
5. Privacy fix without a hash change: the `AlertView.acknowledgedBy` resolver returns `"You"`-style redaction, not
   the subject. Concretely: `acknowledgedBy` resolves to `"you"` when it equals `context.principal.subject`, else to
   `"member-" + handle`. Old builds render it as text, so they still work and no longer show raw ids. This is a
   behaviour change to an existing field and needs a line in the release notes (Q3).
6. Deprecation: keep `alertDetail` for at least two mobile release trains after `alertDetailV2` ships; remove only
   when no client in the supported-version window sends its hash (BFF counter, T6).
7. Failure mode for a NEW client against an OLD BFF: `operation_not_allowed`. Mobile must degrade to "history
   unavailable" and keep the core alert view. Ship the BFF first (section 6).

### 3.4 BFF plumbing (files)

| File | Change |
| --- | --- |
| `services/bff/src/alerts.ts` | `AlertClient.history(principal, token, id, limit, after)`: `requireRole(viewer, operator, admin)`, validate UUID/limit 1..100/cursor charset (`^[A-Za-z0-9_-]{1,512}$`), call `/v1/alerts/${id}/transitions`. Same 8 s timeout and `AlertUpstreamError` mapping. |
| `services/bff/src/schema.ts` | SDL above, `Query.alertHistory` resolver via `requiredAlerts(context)`, `translate(error)`; `AlertView.escalatedAt`; `acknowledgedBy` redaction resolver |
| `services/bff/src/query-policy.ts` | two operations |
| Tests | `alerts.test.ts`, `schema.test.ts`, `query-policy.test.ts` |
| `apps/mobile/src/alerts-client.ts` | `history()` and `alertDetailV2`, byte-identical strings |
| `apps/dashboard/src/AlertsView.tsx` | history section in `AlertDetail` |

## 4. Isolation, authorization, pagination, caching, performance, limits

**Tenant isolation (layered, per `AGENTS.md` rule 1).** Tenant comes only from the verified token (`TenantGuard`).
`withTenant` sets `app.tenant_id` transaction-locally; the query also filters `tenant_id`; `alert_transitions`
has forced RLS. A cross-tenant alert id returns 404 identical to a missing id (episode read first). The BFF forwards
the caller's bearer and never adds a tenant argument. The handle hash includes the tenant id, so the same person
looks different across tenants.

**Authorization.** Read: viewer, operator, admin. Devices are denied by `requireRole`. The acknowledge mutation is
unchanged (operator, admin).

**Pagination.** Keyset, section 2. Default 50, max 100. `nextCursor` null on the last page. Stable under concurrent
inserts because new rows sort strictly after existing ones by version (a new escalation or acknowledgement has a
higher version); the `include=all` suppressed row sorts within its version by time.

**Caching.** Alert history is mutable (acknowledgements, escalations, new updates), so:
- Server: none. `Cache-Control: private, no-store` on the route. The BFF does not cache it. The Read API cache
  (ADR-0015, `invalidateTenant`) is not on the alert path, and the "cache invalidator ADR-0016" named in the request
  **does not exist**: `docs/adr/` has no 0016 file. Do not build on it.
- Client: React Query key `['alertHistory', alertId]`, `staleTime: 0`, and on `acknowledgeAlert` success call
  `invalidateQueries(['alertHistory', id])` and the detail key so the new "acknowledged by you" row appears without
  a manual refresh. Dashboard already re-fetches detail after acknowledge **(unverified for history, new code)**.
  Mobile: same rule in its store.
- ETag = episode version gives a cheap future 304 for direct REST callers; not used through GraphQL POST in v1.

**Performance.** One `readEpisode` (PK), one aggregate (`max(episode_version)`, `bool_or(type='opened')`, index
prefix) on page one only, one range scan of at most 101 rows. Observed 1.7 rows per episode
(4,853 / 2,878 episodes with rows); worst case is bounded by the risk-update flapping rate, which is unbounded in
theory (each `updated` is a row), hence mandatory paging. Target: service p95 < 50 ms, BFF added overhead < 10 ms.
Measure in the Stage 13 harness **(unverified, no load run)**.

**Retention and limits.** `alert_transitions` is append-only and there is no retention job **(unverified: none found
in migrations)**; the runtime cannot delete. Any future archival must keep rows for as long as the alert is visible
in the UI and keep `complete` truthful. Response size cap: 100 items x about 350 bytes. BFF existing per-tenant
rate limit (`services/bff/src/rate-limit.ts`) covers the operation like any other. Log the operation name, alert id,
count and `complete`; never actor ids (the existing log policy avoids PII).

## 5. Test-first plan

Rule: in each layer write the first listed test, watch it fail for the stated reason, then implement.
Coverage must stay above the 80% gate and tenant paths above it.

### 5.1 workflow-alerts (`src/api/api.test.ts`, `src/api/unit.test.ts`; helpers in `src/testing/api.ts`)

| ID | Test | Expected first failure |
| --- | --- | --- |
| **AH-S01 (write first)** | acknowledged alert: `GET /v1/alerts/:id/transitions` returns opened then acknowledged, with correct `fromState/toState/version/type` | 404 (route missing) |
| AH-S02 | `include` default hides `escalation_suppressed`; `include=all` shows it after its version-mate, ordered by `(version, occurredAt, transitionId)` | n/a |
| AH-S03 | ordering when `occurred_at` disagrees with version (insert escalated@2 later than ack@3): version wins | n/a |
| AH-S04 | actor mapping: `system` -> `kind system, isYou false, handle null`; caller who acknowledged -> `isYou true`; a second user in the same tenant -> `isYou false`, 4-hex handle, stable across two alerts | n/a |
| AH-S05 | response never contains the raw subject or the string `workflow-alerts` (JSON-scan of the full body) | n/a |
| AH-S06 | cause mapping per type (risk_event / command / escalation_check with null id) | n/a |
| AH-S07 | pagination: limit 2 over 5 rows walks all rows once; exact-multiple page ends with `nextCursor null`; malformed/foreign cursor -> 400 | n/a |
| AH-S08 | `complete` false for an episode with no `opened` row and for a version gap; true for a normal one | n/a |
| AH-S09 | **cross-tenant**: tenant B token on tenant A alert id -> 404 identical to unknown id; tenant B list never contains A rows; a raw-SQL check that RLS alone (no tenant filter) still returns zero rows for a wrong `app.tenant_id` | n/a |
| AH-S10 | authz: viewer/operator/admin 200; `device` role 403; no token 401 | n/a |
| AH-S11 | `limit` 0, 101, non-integer, `include=x`, non-uuid id -> 400/404 as specified | n/a |
| AH-S12 | DTO: `toAlertDto` adds `escalatedAt` (ISO or null); update existing exact-equality DTO tests | existing DTO test fails until updated |
| AH-S13 | live DB (behind the existing live-test convention) reads real rows through `alerts_app` (SELECT only) | n/a |

### 5.2 BFF (`services/bff/src`)

| ID | Test | Expected first failure |
| --- | --- | --- |
| **AH-B01 (write first)** | `resolvePersistedOperation` accepts the `alertHistory` hash and passes `assertQueryBudget` | `operation_not_allowed` |
| AH-B02 | frozen hashes: SHA-256 of current `alertList`, `alertDetail`, `acknowledgeAlert` (and every other shipped operation) equal a committed golden list | n/a (guards regressions) |
| AH-B03 | `AlertClient.history` sends the caller's bearer, correct path/query, rejects bad id/limit/cursor before any fetch, maps 404/403/503 to `AlertUpstreamError` | n/a |
| AH-B04 | resolver returns page unchanged and does not add any tenant argument | n/a |
| AH-B05 | `acknowledgedBy` redaction: own subject -> `"you"`, other -> `"member-XXXX"`, never the raw value; null stays null | n/a |
| AH-B06 | `alertDetailV2` returns `escalatedAt/resolvedAt/openWindowStart`; `alertDetail` (old) still validates and returns its original fields | n/a |
| AH-B07 | schema test: SDL contains new types; introspection disabled behaviour unchanged | n/a |
| AH-B08 | upstream outage: history unavailable returns the existing `alerts_api_unavailable` translation and does not break `alertDetail` | n/a |

### 5.3 Clients

| ID | Test | Expected first failure |
| --- | --- | --- |
| **AH-M01 (write first)** | mobile: `operations.alertHistory` and `alertDetailV2` byte-equal the BFF strings (existing sync test extended) | missing export |
| AH-M02 | mobile `history()` parses items, treats `complete:false` as a visible "earlier history unavailable" flag, treats `operation_not_allowed` as a soft failure | n/a |
| **AH-D01 (write first)** | dashboard: detail shows a timeline (Opened, Escalated, Acknowledged by you / by Team member 3F2A, Resolved) with `occurredAt`; snapshot of the a11y text | timeline absent |
| AH-D02 | after a successful acknowledge the history query is invalidated and a new "Acknowledged by you" row appears | n/a |
| AH-D03 | no raw subject anywhere in the rendered detail (regex against the fixture subject) | n/a |
| AH-D04 | empty-history and incomplete-history states; keyboard order and screen-reader labels of the list | n/a |

### 5.4 Live acceptance (`make` target left to the implementer; follow the Stage 06 E2E convention in
`scripts/stage06-e2e.mjs`)

| ID | Test |
| --- | --- |
| AH-L01 | real flow: score -> alert -> escalate -> acknowledge as Alice; `alertHistory` shows all steps, Alice sees "You", Bob (same tenant, other subject) sees a handle, a second tenant gets 404 |
| AH-L02 | acknowledge replay with the same Idempotency-Key creates no extra history row |

## 6. Rollout, compatibility, risks, open questions

**Rollout order (each step independently deployable, backward compatible):**
1. workflow-alerts route (additive) and `escalatedAt` field. 2. BFF operations and resolver (old clients unaffected).
3. Dashboard. 4. Mobile release. New clients must tolerate an old BFF (soft failure) and an old workflow-alerts (404
from upstream mapped to "history unavailable").

**Risks.**

| Risk | Mitigation |
| --- | --- |
| Codex owner is mid-change in `services/workflow-alerts` (merge conflicts, disagreement on DTO shape) | Get agreement first; changes are additive and isolated to new functions plus one DTO field; land T1 to T3 as one small reviewed change. |
| History gaps (95 episodes with none, 88 version mismatches in the local DB) | `complete` flag; UI always renders "Opened" from the alert's own `openedAt` and marks history as partial. |
| `occurred_at` non-monotonic | Order by version; document; do not "correct" times. |
| `handle` collisions (16 bits) | Display disambiguator only; never used for identity or authorization. |
| Same `sub` from two issuers in one tenant reads as "You" | Q2. |
| Old shipped builds show a redacted `acknowledgedBy` | Release-note it; low risk (text field). |
| DTO exact-equality tests break when `escalatedAt` is added | Update in the same change (AH-S12). |
| Suppressed no-op rows leak internals if shown | Hidden by default. |

**Open questions (need a human decision).**

- **Q1 Display names.** Do we want them at all? Nothing stores a name or email for other users. Options: (a) keep
  handles (recommended for v1); (b) add a control-plane `display_name` chosen by the member (consented, tenant-scoped,
  erasable) plus a batch tenant-scoped lookup; (c) show the email claim only to admins. Any of b/c needs an ADR
  (next free number is 0023 (unverified) and it changes a privacy invariant) and interacts with review O2 erasure.
- **Q2 Store `identity_id` (pseudonym) instead of `sub` in transitions.** Fixes issuer ambiguity and erasure; changes
  workflow-alerts writes and the events contract; Codex-owned.
- **Q3 Redacting the existing `acknowledgedBy`** for old builds: approve the wording (`you` / `member-XXXX`).
- **Q4** Should score/severity per transition be added as columns now (P2 direction) so the timeline can show "score
  rose to 87"? Recommended as a follow-up, not v1.
- **Q5** Is anything in the platform relying on `alert_transitions` staying out of the public API (for example an
  internal-only audit policy)? Nothing found in docs, unverified with the owner.

## 7. Ordered task list (one implementer each)

| # | Task | Files (owner) | Depends | Touches workflow-alerts |
| --- | --- | --- | --- | --- |
| T0 | Get the Codex owner's agreement on section 2 and the actor mapping; record ADR-0023 (identity display: handles, no raw subject) in `docs/adr/` | `docs/adr/` (docs) | none | agreement only |
| T1 | Route: store functions, parse/DTO mapper, controller route, unit tests AH-S01..S11 (test-first) | `services/workflow-alerts/src/alerts/store.ts`, `src/api/parse.ts`, `src/api/alerts.controller.ts`, `src/api/api.test.ts`, `src/api/unit.test.ts` | T0 | YES |
| T2 | `escalatedAt` in `toAlertDto` and DTO tests (AH-S12) | `services/workflow-alerts/src/api/parse.ts`, tests | T0 | YES |
| T3 | Live-DB test AH-S13 and README route note | `services/workflow-alerts/src/api/*.live.test.ts`, `README.md` | T1 | YES |
| T4 | BFF: `AlertClient.history`, SDL, resolver, operations `alertHistory` and `alertDetailV2`, frozen-hash test, `acknowledgedBy` redaction (AH-B01..B08) | `services/bff/src/alerts.ts`, `schema.ts`, `query-policy.ts`, tests | T1 contract only (can stub upstream) | no |
| T5 | Dashboard timeline, invalidation on acknowledge, a11y (AH-D01..D04) | `apps/dashboard/src/AlertsView.tsx`, tests | T4 | no |
| T6 | Mobile client: `history()`, `alertDetailV2`, soft-failure handling, sync test (AH-M01..M02); BFF counter for deprecated-hash use | `apps/mobile/src/alerts-client.ts`, tests; `services/bff` counter | T4 | no |
| T7 | Live acceptance AH-L01..L02 and evidence file | `scripts/`, `evidence/` | T1, T4, T5 | no |
| T8 | Update `docs/MOBILE_DATA_AVAILABILITY.md` items 8, 10, 22 to 24 with evidence links | docs | T7 | no |

T1 and T4 can start in parallel against the agreed JSON contract in section 2.1 (BFF tests stub the upstream).

## 8. Skills and rules consulted

`ecc-api-design` and `wshobson-api-design-principles` guided the route shape (nouns, sub-resource
`/alerts/:id/transitions`, keyset pagination with opaque cursor, stable error codes, additive versioning);
`addyosmani-api-and-interface-design` guided "never edit a shipped contract, add a new one". No `ecc-event-sourcing*`
skill is installed, so the event-sourcing discussion relies on `ARCHITECTURE_REVIEW.md` P2 and the source above.
Repo rules honoured: forced RLS plus explicit tenant filter, cross-tenant test required, no cache without a stated
invalidation, test-first, no edits outside this file in this task.
