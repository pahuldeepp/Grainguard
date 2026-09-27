# Design: BFF query `alertNotifications` (real notification delivery history)

Status: DESIGN ONLY, 2026-09-26. Nothing in this document is implemented. Author read the sources listed in
section 9 and ran read-only `SELECT`s against the local docker Postgres (`greenguard-dev-postgres-1`); no data was
changed and no recipient value, token or password was printed.

Marking convention: **[V]** verified in source or by a live read-only query; **[U]** unverified or an assumption.

Ownership constraint: the Codex session owns `services/jobs-worker`, `services/notification-service` and
`infra/cdk` (Stage 10d in flight). This design does not edit them. Every step that would touch them is marked
**needs Codex-session agreement**, and section 3 gives a path that needs none of them for the Postgres side.

## 0. Problem and the finding that shapes everything

[MOBILE_DATA_AVAILABILITY.md](../MOBILE_DATA_AVAILABILITY.md) row 25: the delivered-notification log has no API.
Ad-hoc GraphQL is rejected (`persisted_operation_required`, `services/bff/src/query-policy.ts`), so the mobile and
dashboard clients need one new persisted operation backed by a real source.

**Delivery truth is split across three stores, and no single store can answer "what happened to this alert's
notifications".** [V]

| Store | Owner | Path | Knows the alert? | Knows provider outcome and "unknown"? | Has timestamps? |
| --- | --- | --- | --- | --- | --- |
| `greenguard_jobs.notification_intents` (+`dispatch_outbox`, `intent_redrives`, `dead_letter_outbox`) | jobs-worker | warning | YES (`alert_id`, `episode_id`, `transition_version`) | NO. Only `pending/dispatched/sent/failed/suppressed/dead`; it never sees `unknown` | yes |
| `greenguard_notifications.deliveries` + `delivery_attempts` | notification-service | warning | NO (keyed by `intent_id` only) | YES (`received/in_progress/retry/unknown/dead/sent/failed/suppressed`, per-attempt rows) | yes |
| DynamoDB `greenguard-notification-state-<env>`, item `(tenant_id, DELIVERY#<intent_id>)` | infra/cdk Lambda `notification_dispatch.py` | critical | NO | YES (`UNKNOWN/ACCEPTED/REJECTED/SUPPRESSED`) | **NO** |

Consequences:

1. For the warning path the alert index lives in jobs-worker but the honest provider state lives in
   notification-service. A history built from `notification_intents` alone would show `dispatched` for an intent whose
   provider outcome is ambiguous. Live [V]: `deliveries` holds 91 `unknown` rows (82 critical-era email, 9 warning
   email) while the matching intents read `dispatched`.
2. For the critical path the DynamoDB item carries no alert reference, no episode version and no timestamps. Since
   the current jobs-worker skips critical intents (`services/jobs-worker/store.go` lines 43-44 [V]), critical alerts
   have **no rows in the jobs ledger** and cannot be found from it. The join key is derivable: the intent id is the
   deterministic UUIDv5 of `tenant|episode|version|channel` (`event.go` `IntentID`, `notification_dispatch.py`
   `stable_intent_id`, same namespace `5e3a0c51-8b4f-4c2e-9d77-610ad23b14e9` [V]). The episode versions come from
   `alert_transitions` (`workflow-alerts`, column `episode_version` [V]).
3. Neither ledger nor DynamoDB stores a **destination** or a message body [V]. Destinations exist only in the
   PostgreSQL contacts store (one tenant-level email and one tenant-level SMS number, versioned) and its
   DynamoDB projection. So history can be returned with **zero PII by construction**; masked destinations are an
   optional extra (section 2.4).
4. One alert may span both paths: routing is per transition event by `severity` (`Channels()` and the store.go skip
   rule are per event) and `notification_intents.severity` is per intent. An episode that opens as warning and
   escalates to critical would have warning intents in Postgres and critical items in DynamoDB. [U: possible by
   schema; a live check of mixed-severity episodes was not run.] The query must therefore always consult
   both sources.

## 1. The unified `NotificationAttempt` model

One row per **logical notification** = one `(alert episode, transition version, channel)` = one `intent_id`. This is
the unit both paths already deduplicate on. The row aggregates any number of provider attempts. The model contains
no path, provider name, queue name or table name (Hyrum's law: do not leak implementation details). Severity is
returned; the route is implied by it and is not part of the contract.

### 1.1 Fields and sources

| API field | Type | Warning source (Postgres) | Critical source (DynamoDB item) | Notes |
| --- | --- | --- | --- | --- |
| `intentId` | ID | `notification_intents.intent_id` | computed `stable_intent_id`, confirmed by the item key `DELIVERY#<intent_id>` | Stable across retries and redrives [V]. |
| `transitionVersion` | String (decimal) | `transition_version` (bigint) | the `version` used to compute the id | String like `AlertView.version`; int64 exceeds JS safe integers. |
| `transition` | String | `transition` (`alert.opened/escalated/resolved`) | from `alert_transitions.transition_type` (`opened/escalated/resolved`) mapped to the same three values | |
| `severity` | String | `severity` | attribute `severity` **[needs Lambda change]**, else omitted (`null`) | Legacy critical items lack it. |
| `channel` | String | `channel` (`email/sms`; historic `push`) | item `channel` (`email/sms`) | `push` exists only in legacy local data (Stage 10d removes critical push) [V live: 76+265+1232 push rows]. |
| `state` | String | derived, table 1.2 | derived, table 1.2 | Closed vocabulary. |
| `reasonCode` | String or null | sanitised from `last_error` and `deliveries.last_error` | sanitised from item `reason` | Closed vocabulary, section 2.3. Never raw text. |
| `queuedAt` | ISO or null | `notification_intents.created_at` | attribute `created_at` **[needs Lambda change]**, else `null` | When the intent was accepted into the pipeline. |
| `firstAttemptAt` | ISO or null | `first_attempt_at`, and `min(delivery_attempts.recorded_at)` | same as `queuedAt` (single claim) or `null` | |
| `lastAttemptAt` | ISO or null | `greatest(last_attempt_at, max(delivery_attempts.recorded_at))` | attribute `updated_at` **[needs Lambda change]**, else `null` | |
| `resolvedAt` | ISO or null | `deliveries.terminal_at`, or `notification_intents.dead_at` | attribute `updated_at` when status is terminal **[needs Lambda change]** | Null while non-terminal. |
| `dispatchAttempts` | Int or null | `notification_intents.attempts` (broker publish attempts, max 8 [V]) | `null` (SQS retry count is not stored) | Deliberately separate from provider attempts: different meaning. |
| `providerAttempts` | Int or null | `deliveries.attempts` (send attempts) | `1` if any claim exists, else `null` | The Lambda never resends after a claim. |
| `redriveCount` | Int | `notification_intents.redrive_count` | `0` | Operator dead-to-pending redrives. Actor and reason are NOT returned. |
| `contactVersion` | String or null | `null` (not stored) | item `contact_version` | Non-PII version of the contact record used. Lets a UI say "contacts changed since this send". |
| `events[]` | list, max 20 | `delivery_attempts` rows: `kind`, `outcome`, `recorded_at` | empty | `detail` is not returned raw. |

Fields deliberately absent: destination, message subject or body, `provider_ref`, `correlation_id`, `traceparent`,
`source_event_id`, raw `last_error`/`detail`, redrive `actor`/`reason` (operator free text, may hold identities).

### 1.2 State derivation (the honest part)

Vocabulary (String, documented, contract-tested; the repo already uses strings for `AlertView.state`):

| `state` | Meaning to a user | Never claims |
| --- | --- | --- |
| `queued` | Recorded, not yet handed to the delivery mechanism | |
| `dispatched` | Handed to the delivery queue; no provider result yet | |
| `sending` | A provider call was started; result not recorded yet | |
| `retrying` | A transient failure; another attempt is scheduled | |
| `accepted` | The email or SMS provider **accepted** the message | that the handset or inbox received it (no provider delivery receipts exist in the code, `webhook` grep = 0 in notification-service/CDK [V]) |
| `rejected` | Permanent refusal (bad recipient, provider rejected) | |
| `suppressed` | Deliberately not sent (tenant preference, no contact configured) | |
| `dead` | Retries exhausted; needs an operator | |
| `unknown` | The provider call may or may not have been accepted; the system will NOT resend blindly | that it failed, or that it succeeded |

Mapping (rows are checked top to bottom, first match wins):

| Path | Condition | `state` | `reasonCode` |
| --- | --- | --- | --- |
| Warning | `deliveries` row exists, `deliveries.delivery_generation = notification_intents.redrive_count`, status `unknown` | `unknown` | from `last_error` |
| Warning | same generation, status `in_progress` | `sending` | |
| Warning | same generation, status `retry` | `retrying` | from `last_error` |
| Warning | same generation, status `sent` | `accepted` | |
| Warning | same generation, status `failed` | `rejected` | from `last_error` |
| Warning | same generation, status `suppressed` | `suppressed` | `tenant_preference` |
| Warning | same generation, status `dead` | `dead` | `retries_exhausted` |
| Warning | `deliveries` row missing or a lower generation (stale after a redrive), intent status `pending` | `queued` | from `last_error` if any (`broker_unavailable`) |
| Warning | no matching `deliveries`, intent status `dispatched` | `dispatched` | |
| Warning | no matching `deliveries`, intent status `sent/failed/suppressed` (receipt applied, detail unavailable) | `accepted` / `rejected` / `suppressed` | |
| Warning | no matching `deliveries`, intent status `dead` (dispatch never reached the provider: `dead_letter_outbox` row) | `dead` | `broker_unavailable` |
| Critical | item `status = UNKNOWN` | `unknown` | mapped `reason` (`send_started` becomes `send_started_unconfirmed`) |
| Critical | item `status = ACCEPTED` | `accepted` | |
| Critical | item `status = REJECTED` | `rejected` | mapped `reason` |
| Critical | item `status = SUPPRESSED` | `suppressed` | `contact_missing` |
| Critical | no item, transition notifying, alert critical | (no row; see 2.6 "unobserved") | |

Rules that keep it honest:

- `deliveries` wins over the jobs status only when the generations agree; a receipt can lag it (jobs `dispatched`
  while deliveries `sent`), never lead it.
- `unknown` is never coerced to `failed` or `sent`. It is also the state of an item stuck in `in_progress` longer than
  the reconcile window: `sending` older than `NOTIFICATION_STALE_SENDING_SECONDS` (proposed 300 [U]) is reported as
  `unknown` with `reasonCode = send_started_unconfirmed`, matching the ledger's own rule that a row left `in_progress`
  is an uncertain outcome (`notification-service` README, "Timeout is not failure" [V]).
- A row from a source that answered is exact; a source that did not answer is reported in `sources`, not guessed.

## 2. Privacy

### 2.1 Classification

| Item | Class | Handling |
| --- | --- | --- |
| Email address, phone number | PII, direct identifier, confidential | Not present in either ledger or the DynamoDB delivery item [V]. Never returned by this query. |
| Message subject/body | Content | Not stored anywhere [V] (built in memory in the Lambda and in provider adapters). Never stored or returned by this feature. |
| `provider_ref` (provider message id) | Internal identifier | Not returned. Enables provider-console lookup by staff only. |
| `correlation_id`, `traceparent`, `source_event_id` | Internal | Not returned. |
| `last_error`, `detail`, DynamoDB `reason` | May contain hostnames or provider text. Live examples [V]: `connect to broker: dial tcp 127.0.0.1:1: connection refused`, `connection refused ...`, `provider timeout: timed out after 50 ms` | Never returned raw; mapped to `reasonCode` (2.3). |
| `redrive actor/reason` | Operator identity and free text | Not returned. |
| `intentId`, `alertId`, versions, states, times, counts | Operational metadata | Returned, operator/admin only. |
| `contactVersion` | Non-PII counter | Returned. |

### 2.2 No destination in v1

Because the ledgers hold no destination, a "masked destination" per attempt would have to be looked up from the
**current** contact record, which can differ from the one used at send time. That is misleading for a history view
and adds a PII read path. Decision: v1 returns no destination. Recipient-facing information is limited to
`channel` and `contactVersion`. If the owner wants a hint, use the separate query in 2.4.

### 2.4 Optional, separate: masked current contact (needs owner decision, not part of `alertNotifications`)

Only if requested. Computed server-side by the contact owner (control plane), so no other service or client ever holds
the full value; admin role only; never in a list of history rows.

| Kind | Rule | Example shape |
| --- | --- | --- |
| Email | first character of the local part, then `***`, then `@`, then first character of the domain, `***`, and the last label kept only if it is a 2-3 letter TLD | `a***@e***.com` |
| SMS (E.164) | `+`, country prefix up to 3 digits is NOT shown; show `••••` then the last 2 digits | `+••••••••42` |
| Null contact | `null`, never an empty mask | |
| Malformed | `null` and a counter; never echo the input | |

Test vectors are required (T-P4..T-P6, section 5). Never log the pre-mask value.

### 2.3 Sanitised `reasonCode` vocabulary

A pure function `sanitiseReason(source, raw)` with an **allowlist of exact or prefix patterns**; anything unmatched is
`provider_error_unspecified`. Raw text is dropped at this function and never crosses the BFF boundary, is never
logged, and is never placed in a metric label.

| `reasonCode` | Matches (examples from live data or source) |
| --- | --- |
| `provider_timeout` | `provider timeout: ...` |
| `provider_unavailable` | `provider unavailable` |
| `recipient_rejected` | `recipient rejected`, DynamoDB `MessageRejected`, `InvalidParameter`, `InvalidParameterValue`, `OptedOut`, `EndpointDisabled` |
| `provider_auth_or_config` | DynamoDB `MailFromDomainNotVerified`, `ConfigurationSetDoesNotExist`, `ConfigurationSetSendingPaused`, `AuthorizationError`, `PlatformApplicationDisabled` |
| `tenant_preference` | `tenant preference` |
| `contact_missing` | DynamoDB `contact_missing` |
| `send_started_unconfirmed` | DynamoDB `send_started`, stale `in_progress` |
| `not_delivered_resend` | `not delivered; resend with same key` |
| `broker_unavailable` | `connect to broker...`, `connection refused...`, `broker down` (jobs-worker dispatch errors) |
| `retries_exhausted` | jobs or deliveries status `dead` without a more specific cause |
| `validation_error` | DynamoDB `ParamValidationError` |
| `provider_error_unspecified` | everything else |

### 2.5 Audit of who viewed

- Authorization decision and result are logged as one structured line per request from the read service (and mirrored
  as OTel span attributes): `tenantId`, `subjectHash` (SHA-256 of the token subject, not the raw Dex subject),
  `role`, `alertId`, `resultCount`, `sources` status, `requestId`/trace id. No destinations (none exist here),
  no reasons, no bodies.
- A durable audit record is **not available today**: `packages/audit` is an envelope/export foundation whose
  owner-service adapters are "still to implement" (its README [V]). Design: emit the same allowlisted envelope through
  `@greenguard/audit` once an adapter exists (action `notification_history.viewed`); until then the structured log
  is the audit trail and this is listed as an open item (section 8, Q4). Viewing metadata is low sensitivity because no
  PII is returned.

### 2.6 Unobserved notifications

If the Lambda fails before the claim (SQS to DLQ), there is neither an item nor a jobs row. That absence is exactly
what an operator most needs to know. v1 does **not** synthesise "missing" rows (it cannot distinguish lag from loss
and would make a false claim). Instead the response carries `sources.critical` and the BFF may later add
`expectedNotifications` from `alert_transitions`. Tracked as open question Q5.

## 3. Read path options

Requirements: one write owner per aggregate; no service reads another service's tables (owner brief and CLAUDE.md
invariants); tenant from token only; RLS everywhere; no Codex-owned file edited by this design.

| # | Option | Verdict |
| --- | --- | --- |
| A | **Owner read endpoints, BFF composes.** jobs-worker `GET .../notification-intents`, notification-service `POST .../deliveries:lookup`, a read Lambda for DynamoDB | Correct target end state. Three surface changes, all **needs Codex-session agreement**. jobs-worker has no HTTP API or token verifier today (only `/healthz` and `/metrics`; README [V]). |
| B | **New read-only `services/notification-history` (ours) with a hard contract, source adapters behind ports, reading through least-privilege read roles** | **RECOMMENDED for now.** Unblocks mobile and dashboard without editing Codex-owned code (Postgres side). Centralises the cross-store read in one explicit, read-only component. Later option A replaces adapter internals without changing the internal contract, the BFF or any client. Cost: it does violate the letter of "no cross-service table reads", so it needs an ADR exception (task 1). |
| C | BFF reads jobs DB and notifications DB directly | **Reject.** BFF is the edge; adding DB drivers and credentials for two other services' schemas to the internet-facing tier widens blast radius and couples the edge to private table shapes. |
| D | BFF reads DynamoDB directly for critical | **Reject.** Cross-service table read from the edge; needs IAM keys on the BFF; DynamoDB has no alert index (needs computed ids, so also needs the transitions list); and it cannot even produce `when` until the Lambda change. Same conclusion for any client-side or mobile SDK read. |
| E | Event-driven projection into `greenguard_read` (delivery outcome events, CQRS like Stage 05) | Best long-term for pagination and freshness, **rejected for v1**: the critical path would need DynamoDB Streams or a second write (a dual write, rule 2 of AGENTS.md), jobs and notification-service would need new outbox events, and none exist. Revisit after Stage 10d stabilises (Q3). |

### 3.1 Recommended: option B in detail

```
mobile/dashboard --persisted op--> BFF (verify token, role operator|admin)
   BFF --Authorization forwarded--> notification-history  (verify token again, tenant from token)
        1. GET workflow-alerts /v1/alerts/{id}            (alert exists in tenant? else 404)      [existing route, V]
        2. GET workflow-alerts /v1/alerts/{id}/transitions (episode versions, notifying types)    [NEW, ours; backlog item 22]
        3. JobsLedgerSource      SELECT ... FROM notification_intents ... (tenant tx)             [read role, RLS]
        4. DeliverySource        SELECT ... FROM deliveries/delivery_attempts ... (tenant tx)     [read role, RLS]
        5. CriticalStateSource   DynamoDB BatchGetItem on computed keys (tenant partition)        [read IAM role]
        merge -> unified model -> sanitise -> page
```

- Workflow-alerts is our service, so step 2 needs no agreement. Token forwarding matches the existing `AlertClient`
  pattern (`services/bff/src/alerts.ts` [V]); machine-to-machine variants follow ADR-0018/0020 if the owner prefers a
  service credential [U: not re-read here].
- **Postgres read roles (no Codex-owned file edited).** A new idempotent SQL file owned by us, for example
  `infra/compose/grants/notification-history-readers.sql`, run as the DB migrator after each service's migrations by a
  new make target. It creates `notification_history_reader` (LOGIN, NOSUPERUSER, **NOBYPASSRLS**) in each database and
  grants **column-level** SELECT only (fail-closed: columns added later are not visible):

  | DB | Table | Granted columns |
  | --- | --- | --- |
  | `greenguard_jobs` | `notification_intents` | `tenant_id, intent_id, alert_id, episode_id, transition_version, transition, severity, channel, status, attempts, last_error, created_at, updated_at, dispatched_at, first_attempt_at, last_attempt_at, dead_at, redrive_count` (NOT `source_event_id`, `correlation_id`, `traceparent`, `next_attempt_at`) |
  | `greenguard_notifications` | `deliveries` | `tenant_id, intent_id, channel, severity, status, attempts, reconciles, last_error, created_at, updated_at, terminal_at, delivery_generation` (NOT `provider_ref`, `correlation_id`) |
  | `greenguard_notifications` | `delivery_attempts` | `tenant_id, intent_id, attempt_no, kind, outcome, recorded_at, delivery_generation` (NOT `detail`) |

  Why this is safe: the existing `tenant_isolation` policies are `FOR ALL TO public` with `USING (tenant_id =
  app.tenant_id)` and the tables are `FORCE ROW LEVEL SECURITY` [V by `pg_policies`], so a new role is bound by them
  and sees nothing without `set_config('app.tenant_id', $1, true)` in the transaction. The reader gets no INSERT,
  UPDATE, DELETE or function grants, and the selector functions and `*_scan` policies of migration 000005 are not
  used (`jobs_migrator_scan` is `TO jobs_migrator` only [V]). `last_error` is selected only to be classified and
  dropped; if the owner prefers, a reason-code column in their schema makes even that unnecessary (task 9).
  Drift risk: grants outside the owners' forward-only migrations can be lost on re-provision. Mitigation: the make
  target and a startup self-check that fails the readiness probe when a granted column is missing.
- **Tenant transaction.** Same pattern as `WithTenant` in `services/jobs-worker/tenant.go`: `BEGIN`, `set_config(
  'app.tenant_id', $tenant, true)` with a lowercase-UUID check, queries, `COMMIT`. Transaction-local, safe behind
  PgBouncer transaction pooling (ADR-0002 / review R2).
- **DynamoDB (critical).** `BatchGetItem` on keys `(tenant_id = <token tenant>, record_key = DELIVERY#<computed id>)`,
  chunks of 100, `ConsistentRead` true. Locally DynamoDB Local (`greenguard-dev-dynamodb-local-1` is running [V]).
  In AWS this needs a read-only IAM role scoped to `dynamodb:BatchGetItem`/`GetItem` on that table with the leading
  key condition `dynamodb:LeadingKeys = tenant` where the IdP allows it; the CDK grant is **needs Codex-session
  agreement**. Until then `sources.critical = "not_configured"`, an honest partial result.
- **Bounds.** At most 50 notifying transitions per alert per page (at most 100 keys per BatchGet); a per-request
  deadline (3 s per source); a source failure yields `sources.<name> = "unavailable"` and no rows from it, never an
  error for the whole query.

### 3.2 Target after agreement (option A) and what the Codex session would have to add or agree to

The internal contract of `notification-history` (section 4.3) is unchanged; only its adapters change.

| Owner | Minimal read surface | Notes |
| --- | --- | --- |
| jobs-worker | Either (a) a tiny HTTP server (there is `services/jobs-worker/main.go` `/healthz` today, no verifier) exposing `GET /internal/v1/notification-intents?alert_id=&after=&limit=` returning the columns in 3.1, tenant from a verified token or a machine credential (ADR-0018/0020), using `WithTenant`; or (b) a versioned SQL view `notification_intents_read_v1` in one forward-only migration (column list as above) with `GRANT SELECT` to the reader role. Option (b) is the smaller change and keeps `WithTenant` semantics. | One file, one migration. |
| notification-service | `POST /internal/v1/deliveries:lookup` `{intent_ids: [uuid<=100]}`, or the view equivalent of `deliveries` + `delivery_attempts` without `provider_ref`/`detail`. Add a bounded `reason_code` column (or view expression) so raw `last_error` leaves the owner already classified. | Its ledger is the only place provider `unknown` exists. |
| infra/cdk + Lambda | (1) In `_claim`/`_finish` also write `episode_id`, `episode_version`, `transition`, `severity`, `created_at`, `updated_at` (ISO, Lambda clock) to the `DELIVERY#` item; conditional expressions unchanged. (2) A read-only IAM policy for the reader role. (3) Optional: a GSI on `(tenant_id, episode_id)` so history no longer needs computed ids (older items lack it: they stay reachable through computed ids). (4) Optional TTL attribute for retention. | Without (1) the critical rows have `null` timestamps by design, never invented ones. |

## 4. Contract

### 4.1 GraphQL SDL (additions to `services/bff/src/schema.ts` typeDefs)

Convention check [V]: existing types use `String` for closed vocabularies (`AlertView.state`) and decimal-string
`version`; nested lists non-null; nullable for optional data.

```graphql
type NotificationAttemptEvent {
  kind: String!          # send | reconcile | preference
  outcome: String!       # closed vocabulary of the owner ledger, sanitised
  recordedAt: String!    # ISO 8601
}

type NotificationSources {
  warning: String!       # ok | unavailable | not_configured
  critical: String!      # ok | unavailable | not_configured
}

type NotificationAttempt {
  intentId: ID!
  transitionVersion: String!
  transition: String!          # alert.opened | alert.escalated | alert.resolved
  severity: String             # warning | critical | null when unknown (legacy critical items)
  channel: String!             # email | sms | push (push only in legacy data)
  state: String!               # queued dispatched sending retrying accepted rejected suppressed dead unknown
  reasonCode: String           # closed vocabulary, section 2.3
  queuedAt: String
  firstAttemptAt: String
  lastAttemptAt: String
  resolvedAt: String
  dispatchAttempts: Int
  providerAttempts: Int
  redriveCount: Int!
  contactVersion: String
  events: [NotificationAttemptEvent!]!
}

type NotificationAttemptPage {
  items: [NotificationAttempt!]!
  nextCursor: String
  sources: NotificationSources!
}

extend type Query {
  alertNotifications(alertId: ID!, limit: Int!, after: String): NotificationAttemptPage!
}
```

Resolver rules: `requireRole(principal, "operator", "admin")` (viewer excluded, section 6); `alertId` must match the
same UUID regex as `AlertClient` [V]; `limit` integer 1..100 (default the client's choice, mobile sends 50);
`after` must match `^[1-9][0-9]{0,18}:(email|sms|push)$`; violation returns `400 invalid_notification_page`, the
same error shape as `invalid_alert_page` [V]. An alert the tenant cannot see and an alert that does not exist both
return `null`/404 `alert_not_found` (no existence oracle).

### 4.2 Persisted operation for `services/bff/src/query-policy.ts`

Add this entry to `operations` (and copy it **byte-for-byte** into `apps/mobile/src/alerts-client.ts`; a test
already compares the two [V per MOBILE_DATA_AVAILABILITY.md]):

```ts
alertNotifications: `query AlertNotifications($id: ID!, $limit: Int!, $after: String) { alertNotifications(alertId: $id, limit: $limit, after: $after) { items { intentId transitionVersion transition severity channel state reasonCode queuedAt firstAttemptAt lastAttemptAt resolvedAt dispatchAttempts providerAttempts redriveCount contactVersion events { kind outcome recordedAt } } nextCursor sources { warning critical } } }`,
```

SHA-256 of that exact string (computed with Node `crypto`, 2026-09-26):
`2720a99c7a5fd0d84de378bcbd1fabf060ff3277da37d51227d87b07cf0455ff`.
Budget check against `assertQueryBudget` [V]: 25 selected fields (limit 40), maximum depth 4 (limit 6), no
fragments, one operation. Any later edit to the string changes the hash; regenerate it in the same commit.

### 4.3 Internal contract (BFF to `notification-history`)

`GET /v1/alerts/{alertId}/notification-attempts?limit=&after=` with the user's `Authorization` forwarded. Body is
exactly `NotificationAttemptPage` in JSON (camelCase, same field names). Errors use the shared problem format
(`services/workflow-alerts/src/api/problem.ts` pattern). Versioned under `/v1`; additive fields only.

### 4.4 Pagination and limits

- Keyset over the unique natural key `(transition_version ASC, channel ASC)`. `UNIQUE (tenant_id, episode_id,
  transition_version, channel)` exists on `notification_intents` [V], and the critical ids are computed from the same
  tuple, so a single cursor `"<transitionVersion>:<channel>"` is valid for both sources and for the merged stream.
- Each source is asked for `limit + 1` rows after the cursor; results are merged by the same key; the page is cut at
  `limit`; `nextCursor` is the last returned key when more remain, else `null`. A missing source never changes the
  cut rule; the client must treat `sources.<name> != "ok"` as "incomplete".
- Hard ceilings: `limit <= 100`; `events` at most 20 per attempt (newest first); at most 50 transitions per alert
  scanned per request; response size well under 100 KB.
- An alert has a small bounded number of notifying transitions times two channels, so an `after` cursor is a safety
  mechanism, not the main access pattern. There is no total count and no free-text filter (v1 filters: none).

## 5. Test plan (test-first; IDs are new, nothing here exists yet)

Order: contract tests and pure functions first (no infrastructure), then source tests against real local Postgres and
DynamoDB Local, then BFF, then live E2E. Each new tenant path needs a cross-tenant denial test (AGENTS.md rule 1).

| ID | Layer | Test | Location (proposed) |
| --- | --- | --- | --- |
| T-C1 | contract | SDL parses; `alertNotifications` field, types and nullability match section 4.1 | `services/bff/src/schema.test.ts` |
| T-C2 | contract | Persisted operation hash equals the constant in 4.2; registered in `persistedOperations`; passes `assertQueryBudget` | `services/bff/src/query-policy.test.ts` |
| T-C3 | contract | Mobile client copy of the operation is byte-identical | existing comparison test in `apps/mobile` |
| T-C4 | contract | Ad-hoc `alertNotifications` query without the hash is rejected `persisted_operation_required` | `query-policy.test.ts` |
| T-S1 | unit | State mapping: one case per row of table 1.2, including generation mismatch and stale `sending` becoming `unknown` | `services/notification-history/src/state.test.ts` |
| T-S2 | unit | `unknown` is never mapped to `rejected` or `accepted` (property test over all inputs) | same |
| T-S3 | unit | Warning `deliveries` wins over jobs `dispatched` only when generations agree | same |
| T-R1 | unit | `sanitiseReason`: every live raw shape from 2.3 maps to its code; unmatched maps to `provider_error_unspecified` | `reason.test.ts` |
| T-R2 | unit | No output string ever contains an input substring longer than 3 chars from a raw error (fuzz with IPs, hostnames, emails, phone numbers) | same |
| T-P1 | privacy | Response JSON for a fixture with destinations in the contacts store contains no `@`, no `+<digits>`, no field named `email/sms/phone/destination/body/subject/provider_ref/correlation_id/traceparent` | `privacy.test.ts` |
| T-P2 | privacy | Reader role cannot `SELECT provider_ref`, `correlation_id`, `traceparent`, `detail`, `source_event_id` (permission denied) | live DB test |
| T-P3 | privacy | Log capture for a full request contains no raw `last_error`, no destination, no bearer token; contains `subjectHash` not the subject | `audit.test.ts` |
| T-P4..T-P6 | privacy (only if 2.4 is approved) | Mask vectors: email, E.164 SMS, null, malformed; original never logged | control-plane owner |
| T-I1 | tenant | Cross-tenant: tenant B token asking for tenant A's alert id gets `alert_not_found`, no rows, and the sources are not queried (spy) | `service.test.ts` |
| T-I2 | tenant | Live: the reader role with `app.tenant_id` = B reads zero of A's `notification_intents`, `deliveries`, `delivery_attempts`; with no tenant set reads zero | live DB test |
| T-I3 | tenant | DynamoDB source only ever builds keys with the token tenant; a fixture item stored under tenant A is not returned for B even if its intent id is supplied | `critical-source.test.ts` (DynamoDB Local) |
| T-I4 | tenant | Tenant is never read from query, header or body; a forged `tenantId` argument is rejected by the schema | `schema.test.ts` |
| T-A1 | authz | `viewer` gets 403 `insufficient_role`; `operator`, `admin` allowed; service principal denied (`requireRole` rejects `principalType === "service"` [V]) | `resolvers.test.ts` |
| T-A2 | authz | Unauthenticated and expired token get 401 before any source call | same |
| T-G1 | golden | Live-shape fixtures for warning (sent, unknown, dead, redriven) and critical (ACCEPTED, UNKNOWN, REJECTED, SUPPRESSED, legacy item without timestamps) produce the exact expected JSON | `merge.golden.test.ts` |
| T-G2 | golden | Alert that spans both paths returns both, merged by `(version, channel)` | same |
| T-K1 | keyset | Pagination: limit 1 walks every row exactly once, no duplicates or gaps, across both sources | same |
| T-K2 | bounds | `limit` 0, 101, non-integer, malformed `after` all give `400 invalid_notification_page` | `resolvers.test.ts` |
| T-F1 | failure | One source throws or times out: response still 200, `sources.<name> = "unavailable"`, other rows present | `service.test.ts` |
| T-F2 | failure | Critical source not configured returns `not_configured` and no error | same |
| T-F3 | failure | DynamoDB `UnprocessedKeys` are retried with backoff then reported as `unavailable` | `critical-source.test.ts` |
| T-F4 | failure | Read role lacking a granted column fails readiness (not a 500 per request) | live DB test |
| T-E1 | live E2E | `make stage06-e2e`-style run: synthetic warning alert produces intents; the API shows `accepted` after the local adapter sends, `unknown` when the adapter simulates a timeout, `dead` after broker failure; no raw error text in the response | `scripts/notification-history-e2e.mjs` |
| T-E2 | live E2E | Critical alert against DynamoDB Local with the real `notification_dispatch.dispatch_one`: ACCEPTED, UNKNOWN (SES throws a non-rejecting error) and SUPPRESSED (no contact) reflect correctly | same, Python fixture reuse of `infra/cdk/test_lambda_handlers.py` doubles [U] |
| T-E3 | live E2E | Browser/mobile: alert detail shows the history for operator, hides it for viewer | dashboard/mobile tests |
| T-X1 | regression | After a redrive (`redrive_count` 1) the old generation's `sent`/`failed` deliveries row does not override the new pending state | `state.test.ts` plus live |

Coverage: 80% gate; aim above it for `state.ts`, `reason.ts`, the tenant transaction helper and the privacy tests
(security-critical paths per CLAUDE.md).

## 6. Authorization

- Roles: **operator and admin only.** `viewer` is excluded because the data reveals which alerts failed to notify and
  provider error classes (operational security information), and it mirrors `RESPONDERS` used for acknowledge.
  `viewer` continues to see the alert itself. [Owner decision Q1: allow viewer read-only?]
- Tenant comes only from the verified token (`TenantGuard` pattern [V]); the BFF verifies, the read service verifies
  again (defence in depth), and the DB enforces RLS with the transaction-local tenant.
- Service principals cannot call it (`requireRole` denies them [V]); a machine caller would need a distinct explicit
  rule and ADR-0020 tenant binding.
- Rate limiting: the BFF's existing limiter [V] applies; the read service additionally caps concurrent source queries
  per request.

## 7. Rollout and compatibility

1. Additive only: a new query, new types, one new persisted operation. No existing operation or type changes; older
   mobile builds simply never send the new hash.
2. Mobile: the operation must be added to `apps/mobile/src/alerts-client.ts` in the same change as `query-policy.ts`
   (byte-identical test). Feature flag `notifications_history_enabled` in the client so the UI can ship before the
   backend.
3. Phasing: Phase 0 BFF and contract with an in-memory fake source (everything `not_configured`); Phase 1 Postgres
   sources through the read roles (warning path complete, critical partial); Phase 2 critical path after the Lambda
   and IAM agreement; Phase 3 optional switch to option A adapters.
4. Vocabulary evolution: adding a `state` or `reasonCode` value is additive but strict clients must treat unknown
   values as `unknown`/generic. Document this on the operation. Removing a value is a breaking change and needs the
   `deprecation-and-migration` process.
5. Forward-only: nothing here alters Codex-owned migrations; the grant script is idempotent and re-runnable.

### Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | Reader role grants live outside the owners' migrations and can drift or vanish on re-provision | Make target after migrations; readiness self-check; plan to move into owner migrations (task 9) |
| 2 | Column changes in the owners' tables break the reader | Column-level grants fail closed; T-F4; owners agree to a `notification_intents_read_v1` view under option A |
| 3 | Cross-store merge shows a transient inconsistent state (receipt lag) | Rules in 1.2; documented; `updatedAt`-style fields are not promised to be monotonic across sources |
| 4 | `accepted` is misread as "delivered to the phone" | Name and docs say provider accepted; no delivery receipts exist today |
| 5 | Critical rows have `null` timestamps until the Lambda change | Nullable fields; never fabricate; UI shows "time unavailable" |
| 6 | Critical loss (no claim written) is invisible | Explicit Q5; `sources` reporting; future `expectedNotifications` |
| 7 | Local data is noisy (legacy critical rows in jobs, `alert_id != episode_id` on 1719 of 5482 rows [V live]) | Join strictly on `episode_id`; a live test must not assume `alert_id = episode_id`. **Verified only for rows created by the current intake (`alert_id` = `episode_id`); legacy rows differ.** |
| 8 | Extra hop and latency (three sources) | Parallel fetch, 3 s per-source deadline, bounded keys, partial results |
| 9 | New service adds operational surface | Read-only, no queue, no state; reuses the workflow-alerts service skeleton |
| 10 | PII appearing later through a new field in an owner table | Column allowlist plus T-P1 field-name and value scans on every response |

## 8. Open questions for the owner

| # | Question | Default if unanswered |
| --- | --- | --- |
| Q1 | May `viewer` see delivery history, or operator and admin only? | operator and admin only |
| Q2 | Accept an ADR exception allowing the read-only `notification-history` service with column-level reader roles as an interim (option B), with option A as the target? | yes, interim only |
| Q3 | Should the long-term source be an event-driven read model (option E), and if so does Stage 10d add DynamoDB Streams or a delivery-outcome outbox? | defer past 10d |
| Q4 | Is a structured log acceptable as the "who viewed" audit until `@greenguard/audit` has an owner-service adapter, or must this wait for a durable record? | log now, durable later |
| Q5 | Should missing critical notifications (no item, no jobs row) be surfaced as `expected but unobserved` after N minutes? Needs an SLO for Lambda latency. | not in v1 |
| Q6 | Retention: how long must delivery history be queryable? DynamoDB items have no TTL [V: CDK table has no TTL attribute]; ledgers have no purge job [U]. | 90 days documented, unenforced |
| Q7 | Show a masked current contact (2.4)? If yes: admin only, owner-computed, separate query. | no |
| Q8 | Should `push` remain in the vocabulary given Stage 10e defers it and 10d removes critical push? | keep, marked legacy |
| Q9 | Service name and language for `notification-history`: NestJS/TypeScript like workflow-alerts (proposed) or Go like jobs-worker? | NestJS/TypeScript |
| Q10 | Provider delivery receipts (SES/SNS events, SendGrid/Twilio webhooks) are the only way to ever say `delivered`. Out of scope, but confirm we do not promise it. | not promised |

## 9. Ordered task list with file ownership

"Ours" = this session's scope. Every task touching `services/jobs-worker`, `services/notification-service` or
`infra/cdk` is marked **needs Codex-session agreement** and is not started without it.

| # | Task (test-first, IDs from section 5) | Files | Owner |
| --- | --- | --- | --- |
| 1 | ADR: notification-history read model, option B interim with option A target, column-level reader roles, privacy rules (2.x), authz | `docs/adr/00NN-notification-history-read-model.md` | Ours |
| 2 | Contract and pure logic first: `state.ts`, `reason.ts`, `merge.ts`, cursor codec, fixtures from live shapes; tests T-S*, T-R*, T-G*, T-K* | new `services/notification-history/src/*` | Ours |
| 3 | `GET /v1/alerts/{id}/transitions` (episode versions, types, times) in workflow-alerts (backlog item 22) with tenant test | `services/workflow-alerts/src/api/alerts.controller.ts`, `src/alerts/store.ts`, tests | Ours |
| 4 | Read-role SQL and make target; readiness self-check; T-P2, T-I2, T-F4 (live) | `infra/compose/grants/notification-history-readers.sql`, `Makefile`, service repo | Ours (files are not in the three Codex-owned trees) |
| 5 | Sources: `JobsLedgerSource`, `DeliverySource` over the reader roles; T-I*, T-F*, T-X1 | `services/notification-history/src/sources/*` | Ours |
| 6 | `CriticalStateSource` over DynamoDB with computed keys; DynamoDB Local tests T-I3, T-F3; `not_configured` when no table env | `services/notification-history/src/sources/critical.ts` | Ours (local) |
| 7 | BFF: typeDefs, resolver, `NotificationHistoryClient`, role check, persisted operation, hash test; T-C*, T-A*, T-I1, T-I4 | `services/bff/src/schema.ts`, `query-policy.ts`, new `notification-history.ts`, tests | Ours |
| 8 | Mobile and dashboard clients: operation copy, alert-detail panel behind a flag; T-C3, T-E3 | `apps/mobile/src/alerts-client.ts`, `apps/dashboard/src/*` | Ours |
| 9 | Lambda writes `episode_id`, `episode_version`, `transition`, `severity`, `created_at`, `updated_at` on `DELIVERY#` items; optional GSI and TTL; read-only IAM policy for the reader | `infra/cdk/lambda/notification_dispatch.py`, `infra/cdk/greenguard_serverless_stack.py`, `infra/cdk/test_*.py` | **needs Codex-session agreement** |
| 10 | Owner-side read surface: `notification_intents_read_v1` view (or HTTP) and grants inside the owner migration; move grants out of the make target | `services/jobs-worker/migrations/*`, `services/jobs-worker/README.md` | **needs Codex-session agreement** |
| 11 | Owner-side read surface for `deliveries`/`delivery_attempts` without `provider_ref`/`detail`, plus a bounded `reason_code` | `services/notification-service/migrations/*`, `services/notification-service/src/*` | **needs Codex-session agreement** |
| 12 | Live E2E T-E1 and T-E2 and evidence file; update `docs/MILESTONES.md` only with linked evidence under `evidence/` | `scripts/notification-history-e2e.mjs`, `evidence/*` | Ours (T-E2 depends on 9) |
| 13 | Docs: mark MOBILE_DATA_AVAILABILITY row 25 status after evidence exists | `docs/MOBILE_DATA_AVAILABILITY.md` | Ours |

Dependency order: 1 -> (2, 3, 4 in parallel) -> 5 -> 6 -> 7 -> 8 -> 12. Tasks 9-11 are independent of 2-8 and only
improve completeness (9) or replace adapter internals (10, 11); the feature ships useful warning-path history with
none of them.

## 10. Sources read

`docs/MOBILE_DATA_AVAILABILITY.md`, `evidence/MOBILE_DATA_AVAILABILITY_LIVE.md`, `CLAUDE.md`, `AGENTS.md`,
`docs/ARCHITECTURE_REVIEW.md`, `docs/STAGE_10_PLAN.md`, `docs/superpowers/plans/2026-09-25-stage-10d-notifications.md`,
`services/jobs-worker/migrations/000001..000005`, `store.go`, `dispatcher.go`, `event.go`, `tenant.go`, `README.md`;
`services/notification-service/migrations/0001..0002`, `src/ledger.ts`, `src/providers.ts`, `README.md`;
`infra/cdk/lambda/notification_dispatch.py`, `infra/cdk/greenguard_serverless_stack.py`;
`services/bff/src/query-policy.ts`, `alerts.ts`, `schema.ts`, `main.ts`; `services/workflow-alerts/src/api/auth.ts` and
the `alert_transitions` migration; `packages/audit/README.md`, `packages/tenant-auth/src/index.ts`. Live read-only
queries: row counts by status/channel, shape of error strings (with ids masked), policies and grants. Not read in
full: `docs/STAGE_06_PLAN.md`, ADR-0018 and ADR-0020 (referenced as patterns only [U]), and the three named API design
skills were skimmed for principles only (contract first, no leaked internals, consistent error semantics,
nullable optional data, versioned additive change).
