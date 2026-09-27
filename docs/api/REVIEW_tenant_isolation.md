# Tenant-isolation review of the four BFF API designs (2026-09-26)

Reviewer: `tenant-isolation-reviewer` (read-only; text saved here by the coordinator). Read-only `psql` selects were run as `postgres` against the local databases; no data or secrets were printed.

## Verified facts

- Jobs and notifications databases: `notification_intents`, `dispatch_outbox`, `intent_redrives`, `dead_letter_outbox`, `inbox`, `deliveries`, `delivery_attempts`, `notification_preferences` are ENABLE + FORCE ROW LEVEL SECURITY with a `tenant_isolation` policy `FOR ALL TO public` on `NULLIF(current_setting('app.tenant_id', true), '')::uuid` and a matching `WITH CHECK`. Any new non-owner role is bound by them.
- `jobs_app` and `notifications_app` are non-super, non-BYPASSRLS, with INSERT/SELECT/UPDATE only and no default ACLs. No `notification_history_reader` role exists yet: the proposed column grants are unverifiable today.
- `jobs_migrator_scan` is `TO jobs_migrator USING (true)`: the reader must never be a member of any `*_migrator`. `quarantined_events` and `schema_migrations` have no RLS and must stay out of the reader grants.
- Primary keys are `(tenant_id, intent_id)` but `UNIQUE (intent_id)` is global on `notification_intents` and `deliveries`; no cross-database foreign keys. `alert_transitions` and `alert_episodes` have composite tenant FKs and forced RLS.
- `bin_views` / `site_views` do not exist; read-DB migration 000001 applies RLS from an explicit table-name array, not a pattern.
- `operationCharge` (`services/bff/src/rate-limit.ts`) returns cost 1 for any operation it does not list.

## Findings

### HIGH
- **H1 (notifications §3.1) DynamoDB has no RLS; critical-alert isolation rests on app code.** The design grants `BatchGetItem` on the whole table and relies on `dynamodb:LeadingKeys "where the IdP allows"`, but LeadingKeys is enforced by IAM/STS session tags. One bug building a key from a non-token tenant reads another tenant's critical delivery state. Fix: a single key-builder that accepts only the verified `Principal` (no tenant parameter anywhere); per-request STS AssumeRole with a `tenant` session tag and policy `dynamodb:LeadingKeys = ${aws:PrincipalTag/tenant}`; if deferred, keep `sources.critical = "not_configured"` in production. First failing test: DynamoDB Local, store under tenant A, request as B, assert B's keys contain only B's tenant AND an IAM policy simulation denies A's leading key.
- **H2 (notifications §3.1, §9 task 4) The reader role is granted outside the owners' migrations.** A re-provision losing the column list falls back to a broader grant, or the script adds the role to `jobs_migrator` and inherits `USING (true)`: cross-tenant read of every intent. Fix: `CREATE ROLE ... NOSUPERUSER NOBYPASSRLS NOINHERIT`, never a member of any `*_migrator`, `REVOKE ALL` first, and a startup/readiness self-check (no role membership, `rolbypassrls` false, `pg_policies` still has `tenant_isolation` with the expected `qual`). First failing test (live): connect as the reader with no `app.tenant_id` and with another tenant's id, assert zero rows from `notification_intents`, `deliveries`, `delivery_attempts`; add the membership and `pg_policies` assertions to T-I2.

### MEDIUM
- **M1 (all four) No pooled-connection / after-rollback test (D03-style).** `set_config` is transaction-local, so a path that skips the transaction (for example `Promise.all` on a pooled client outside `BEGIN`) leaks the previous tenant's context. First failing test per design: tenant A query, then tenant B on the same pooled connection, then a no-context query (expect 0 rows); repeat after a forced error + ROLLBACK and after the proposed `statement_timeout` abort.
- **M2 (history §3.2, notifications §4.2) New operations are not registered in `operationCharge`** (unlisted names cost 1); `alertNotifications` fans out to three stores plus a DynamoDB BatchGet of up to 100 keys. Fix: explicit costs (for example `alertHistory` 2, `alertNotifications` 5); make `operationCharge` throw on an unregistered name. First failing test in `rate-limit.test.ts`.
- **M3 (bin-readings §4.4) Bulkhead is 4 per tenant / 32 global with no per-tenant share of the global cap:** enough tenants fill it and everyone else gets 503 `read_busy`. Fix: reserve a slot per active tenant or a weighted queue. First failing test: saturate as many tenants, assert tenant Z still gets a slot.
- **M4 (notifications §2.5) Audit `subjectHash` is a plain SHA-256 of the subject;** subjects are short and guessable, so log readers can confirm who viewed. Fix: HMAC with a server secret over tenant + subject (as history §1.4); tenant in log fields only, never metric labels. First failing test: the log value must not equal `sha256(subject)`.
- **M5 (history §1.4) `isYou`/`handle` ignore the issuer:** two issuers in one tenant sharing a `sub` make one person read as "You" on another's acknowledgement. Fix: compare `iss|sub`, or block multi-issuer tenants on this route until Q2 is decided. First failing test: acknowledge as `{iss:A, sub:x}`, request as `{iss:B, sub:x}`, assert `isYou = false`.
- **M6 (history §2.1) The REST route is reachable directly and exposes more than the persisted operation:** `?include=all` returns `escalation_suppressed` rows and every item carries `cause.id` and `eventId`. Fix: `include=all` admin-only; `cause.id` only for operator/admin, or drop it from the REST DTO. First failing test: a viewer token with `include=all` returns 403.

### LOW
- **L1 (history §2.1, notifications §4.4) Cursors are unsigned and not bound to an alert.** They only skip rows across alerts (queries still filter tenant and episode). Fix: include the alert id, or an HMAC over tenant + alert + position; reject a mismatch with 400.
- **L2 (notifications §1.1, §3.1) The cross-store merge must key on `(tenant_id, intent_id)`,** because `UNIQUE(intent_id)` is global in both databases. Test: two tenants holding the same `intent_id` in `deliveries` and `notification_intents`.
- **L3 (alert-detail §2.2) "Same DO $$ loop as 000001" would give `bin_views`/`site_views` no RLS** (explicit array). Grants are UNVERIFIED: `read_query` needs SELECT (views use `security_invoker`), writes only to `projection_app`. Test: after the migration assert `relrowsecurity` and `relforcerowsecurity` on both tables and no write grants for `read_query`.
- **L4 (notifications §3.1)** The "who viewed" audit is only a log until `@greenguard/audit` has an adapter (Q4): acceptable only because no PII is returned (enforce with T-P1).
- **L5 (bin-readings §4.2)** `getBinLatest` uses `$4` (the bin) but its signature lists only `deviceIds` and `since`: keep explicit `tenant_id` and `bin_id` predicates in every lateral subquery.

## Checks that pass

Tenant comes only from the verified token/principal in all four (no tenant argument, header or body field). Not-found is indistinguishable for foreign, unknown and unbound ids (alert-detail null; alert-history 404 because `readEpisode` runs first; bin-readings `data: null`; notifications alert-existence check before any source query). Every proposed query has an explicit tenant predicate plus RLS. DataLoaders are per request; bin/site batches use ADR-0015 tenant-scoped keys; alert history is not cached. The alert-history handle hashes tenant + subject (4 hex) and `acknowledgedBy` is redacted. The UUIDv5 intent id cannot be used to enumerate another tenant (tenant component comes from the token). `reasonCode` is a closed vocabulary; no destinations, bodies, `provider_ref` or `correlation_id`. The persisted-operation allow-list takes only ids as variables.

## Cross-tenant negative tests: specified vs missing

| Design | Specified | Missing (write this failing test first) |
| --- | --- | --- |
| alert-detail | AD-X1..X5 | `bin_views`/`site_views` RLS forced + no write grants for `read_query` (L3); a batch of A and B bin ids returns only the caller's; pooled-connection test (M1) |
| alert-history | AH-S09, AH-L01 | cursor from another alert/tenant rejected (L1); viewer `include=all` returns 403 (M6); issuer collision (M5); pooled connection (M1) |
| bin-readings | BR-XT-01..05, BR-RM-07, BR-RA-10 | BR-RM-07 also with the explicit predicate removed (RLS alone); per-tenant fairness (M3); pooled connection and after-statement-timeout rollback (M1); service principal `read:telemetry` tenant binding at read-api (Q5) |
| notifications | T-I1..I4, T-P2, T-A1, T-A2 | reader role membership/policy self-check (H2); IAM leading-key denial (H1); `notification-history` itself rejects a viewer or wrong-audience token (T-A1 only tests BFF resolvers); merge keyed on tenant + intent (L2); cost registration (M2); pooled connection (M1) |

## Per-design verdicts

- alert-detail: APPROVE with changes (explicit RLS names in the migration, explicit `read_query` grants, pooled-connection test).
- alert-history: APPROVE with changes (M2, M5, M6, cursor binding).
- bin-readings: APPROVE with changes (fair bulkhead M3, M1 and RLS-alone tests).
- alert-notifications: BLOCK until H1 and H2 are resolved (the only new DB roles and the only store without RLS); M2 and M4 also apply.
