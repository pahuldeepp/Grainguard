# Stage 09 — SaaS identity, billing, quotas, entitlements and audit export

Status: **planned, not started**. Nothing in this document is implemented. It is an
execution plan: where the existing docs decide, the decision is restated with a
citation; where they do not, it is marked **OPEN DECISION** with a recommendation and
the cost of being wrong. Decisions that change an invariant must be recorded as ADRs
in `docs/adr/` before the slice that depends on them starts (CLAUDE.md, "Before
writing any code", step 5).

Backlog row (docs/IMPLEMENTATION_BACKLOG.md, Stage 09): *SaaS: Auth0 teams/SSO, roles,
API keys, quotas, Stripe metering/subscriptions, audit export, feature flags*.
Dependency: 08. Exit gate: *sandbox purchase/webhook/replay/cancel flows correct;
membership revocation works; tenant-scoped entitlements and audit proven*.

Coverage IDs owned or touched (docs/COVERAGE_MATRIX.md): P06 Stripe (line 82), P07
Auth0 organizations/invitations/SSO (line 83), P08 API keys/quotas/plan limits
(line 84), P13 OpenFeature (line 89), P14 audit logging and export (line 90), S01
OIDC/JWKS/RBAC (line 96), X11 quota layers (line 144), X12 API-key cryptography
(line 145), X13 soft delete/retention/export (line 146), Z07 provider identity
limits (line 192). Review gaps touched: R4, R5, O1, O2, O3
(docs/ARCHITECTURE_REVIEW.md lines 41, 42, 50–52).

## 1. Scope, dependencies and what Stage 08 must verify first

### 1.1 What exists today (verified by reading, 2026-09-25)

| Component | State | Evidence |
|---|---|---|
| `services/tenant-control-plane` | README only: "planned, not implemented" | `services/tenant-control-plane/README.md` |
| `services/billing-service` | README only: "planned scaffold; implementation not started" (NestJS, Prisma, Stripe) | `services/billing-service/README.md` |
| `packages/audit` | README only, stages 03, 09 | `packages/audit/README.md` |
| `packages/feature-flags` | README only, OpenFeature + DynamoDB, stages 09, 10 | `packages/feature-flags/README.md` |
| `packages/idempotency` | README only, stage 03 (the real receipt logic lives inside each service) | `packages/idempotency/README.md` |
| `packages/tenant-auth` | **Real code with tests.** `Role = "viewer" \| "operator" \| "admin" \| "device"` (`src/index.ts:9`), `createTokenVerifier` (`:116`), `requireRole` (`:162`); membership file parser `parseMemberships` (`src/oidc.ts:11`), `membershipMapper` (`:45`), `refreshableMemberships` (`:77`), `createTokenVerifierFromEnv` (`:117`); tests in `src/index.test.ts`, `src/oidc.test.ts` | files listed |
| Membership source | Static JSON fixture keyed by `issuer|subject` → `{tenantId, roles}`, three Dex users across two tenants | `infra/oidc/memberships.json` |
| Refresh / revocation | BFF and Read API refresh the map every `AUTH_MEMBERSHIP_REFRESH_MS` (30 s default); last good map kept at most `AUTH_MEMBERSHIP_MAX_STALE_MS` (5 min) then fail closed with `401 invalid_claims`; saga API rereads per request. "This is not immediate platform-wide revocation." | docs/adr/0014-oidc-identity.md, Consequences |
| Local IdP | Dex v2.43.1 opt-in, cannot add `tenant_id`/`roles` claims (fits R4) | docs/adr/0014-oidc-identity.md, Decision 1; `infra/oidc/compose.yaml` |
| Tenants table | `tenants(tenant_id, name, created_at)` in device-service (`greenguard_inventory`) | `services/device-service/prisma/schema.prisma` lines 16–24; docs/FIRST_VERTICAL_SLICE.md line 28 |
| Audit table | `audit_events` (actor, action, resource, command_id, event_id, outcome, occurred_at) in device-service | `services/device-service/prisma/schema.prisma` lines 142–157 |
| Ingest rate limits | In-memory per-device and per-tenant token buckets behind `Limiter` | `services/telemetry-ingest/ratelimit.go` (`type Limiter` line 11, `NewTokenBuckets` line 129); docs/adr/0007-ingest-rate-limiting.md |
| BFF limits | Redis-backed tenant and user token buckets, fail closed with 503 | docs/STAGE_08_PLAN.md, slice 3 |
| Env contract | `OIDC_DEV_PASSWORD`, `VITE_OIDC_*`, `AUTH_MEMBERSHIP_FILE`; no Stripe or Auth0 variables yet | `.env.example` lines 73–80 |
| Contracts | `contracts/events/` has device, facility, lot, telemetry, risk, alert, projection schemas; **no** tenant, membership, billing, usage or config schemas | `ls contracts/events` |

### 1.2 Decided by existing docs

- **Topic families already named** (docs/PLATFORM_CONTRACTS_AND_OPERATIONS.md §3, lines 85, 94, 98):
  `greenguard.inventory.tenant.v1` (`tenant.created`, `tenant.updated`,
  `membership.changed`, `tenant.suspended`; "extracted to control plane at Stage 09");
  `greenguard.billing.lifecycle.v1` (`subscription.changed`, `entitlements.changed`,
  `usage.accepted`, `billing.reconciliation_required`);
  `greenguard.platform.config.v1` (`flag.configuration_changed`,
  `cell.placement_changed`). Topics are per cell and family, never per tenant (line 81).
  This plan keeps those names; it does not invent `usage.recorded` as a new topic
  (see §3.4).
- **Public routes** (same doc §4, line ~131, ~135): `/v1/billing/checkout`,
  `/v1/billing/portal`, `/v1/usage`, `/v1/entitlements`; `/webhooks/stripe` with
  "raw-body signature verification and durable deduplicated webhook inbox";
  `/v1/tenants`, `/v1/memberships`; `/v1/exports`. Command endpoints need an idempotency
  key; version-sensitive mutations need an expected version/ETag; conflicting key
  reuse → `409` (line ~138).
- **Control plane ownership** (same doc line 29; docs/SCALE_AND_PRODUCTION_READINESS.md
  lines 92–93): Stage 09 extracts authoritative membership/profile/placement and
  billing control out of device-service; "migrate ownership with one writer, versioned
  events and reconciliation"; control-plane outage must not stop existing tenant
  requests.
- **Flags** (same doc §9, line 255): OpenFeature is the evaluation port; local static
  provider and DynamoDB are adapters; typed defaults and last-known-good cache; flag
  outages cannot bypass authorization, outbox durability or receipt checks; record the
  configuration version in decisions that affect billing.
- **Secrets** (same doc line 75): Git and logs hold names/references only; rotation
  tests cover webhook verification overlap.
- **Identity split** (docs/adr/0014-oidc-identity.md): the IdP proves identity only;
  GreenGuard maps `iss|sub` to membership; IdP-asserted `tenant_id`/`roles` are
  overwritten; missing membership → 401.
- **Isolation invariants** (CLAUDE.md "Architecture invariants"; AGENTS.md rules 1–3):
  `tenant_id` + forced RLS + composite tenant FKs + non-owner runtime role +
  `set_config(..., true)`; outbox for every domain change; inbox for every consumer;
  explicit lock choice per contended table (docs/adr/0002-concurrency-control.md).

### 1.3 Stage 08 preconditions (must be green before 09 exit, not before 09 design)

Stage 09's gate depends on 08 (backlog dependency). Before any 09 slice claims its
gate, the following Stage 08 items must have evidence under `evidence/`:

1. OIDC login + RS256 verification with the membership mapper against Dex
   (`evidence/STAGE_08_OIDC_VALIDATION.md` exists; ADR-0014 still **Proposed** — it
   must be Accepted, because 09a replaces its Decision 2 data source).
2. Browser → BFF → Read API and → saga flows (`evidence/STAGE_08_E2E_VALIDATION.md`
   exists, local only).
3. Two-tenant REST/GraphQL/WS/cache denial tests (Stage 08 gate item 5, still open in
   docs/STAGE_08_PLAN.md). 09a revocation tests reuse this harness.
4. Gateway role: the backlog puts entitlement and API-key enforcement at
   "gateway/ingest" (COVERAGE_MATRIX line 84). `services/gateway` is currently a
   README; see OPEN DECISION D6 for where enforcement lives if the gateway is still
   unbuilt.

Slices 09a–09c, 09e and 09f can be designed and built against Dex and the local stack
while 08 finishes; only the combined Stage 09 gate waits.

### 1.4 Out of scope for Stage 09

Production Auth0 tenant provisioning, live-mode Stripe, tax filing, cross-region
residency enforcement (O3 decision only), DynamoDB flag adapter (Stage 10 per
`packages/feature-flags/README.md`), S3 export storage (P11 is Stage 10; 09e uses a
local object-store abstraction), crypto-shred implementation (O2: 09 adds hooks and
the data classification, Stage 14 proves deletion across backups).

## 2. Slices

Each slice ends with a green gate (unit + integration tests, `make verify`, 80%
coverage with higher coverage on isolation/idempotency paths, Sonar clean, CodeRabbit
review) and one evidence file. Live checks are separate make targets kept out of
`make verify` (same pattern as `make events-e2e`, `make browser-e2e`).

| Slice | Deliverable | Owner (service / package) | Depends on | Evidence file |
|---|---|---|---|---|
| 09a | Tenant control plane: organizations, first-party memberships, invitations, role model, revocation propagation, audit | `services/tenant-control-plane` (new), `packages/tenant-auth` (new membership source) | 08 OIDC | `evidence/STAGE_09A_VALIDATION.md` |
| 09b | API keys: hashed at rest, scopes, rotation, revocation, per-key limits, device vs user keys | `services/tenant-control-plane` (key issuance), `packages/tenant-auth` (key verifier), `services/telemetry-ingest` (device key path) | 09a | `evidence/STAGE_09B_VALIDATION.md` |
| 09c | Entitlements and quotas: plan model, enforcement points, overage policy | `packages/entitlements` (new), enforcement adapters in device-service, telemetry-ingest, read-api, BFF | 09a (tenant), 09d contract only (can use a static plan until 09d lands) | `evidence/STAGE_09C_VALIDATION.md` |
| 09d | Billing service in Stripe **test mode**: catalog, checkout, lifecycle, metering, webhooks, replay, cancel/downgrade, dunning, reconciliation | `services/billing-service` (new code) | 09a; emits the entitlement source 09c consumes | `evidence/STAGE_09D_VALIDATION.md` |
| 09e | Audit export: tenant-scoped, signed, paginated, redacted, async large export, retention | `packages/audit` (new code), `services/tenant-control-plane` export API, `services/jobs-worker` job handler | 09a (actors), existing `audit_events` | `evidence/STAGE_09E_VALIDATION.md` |
| 09f | Per-tenant feature flags via OpenFeature with tenant context and safe defaults | `packages/feature-flags` (new code) | 09a (tenant context) | `evidence/STAGE_09F_VALIDATION.md` |
| 09g | SSO/Auth0 path, authentication only; per-tenant OIDC/SAML connections as an option; Dex kept for tests | `packages/tenant-auth` (multi-issuer config), `services/tenant-control-plane` (connection registry), `infra/oidc` | 09a | `evidence/STAGE_09G_VALIDATION.md` (+ owner-run `evidence/STAGE_09G_AUTH0_SANDBOX.md`) |
| Gate | Combined exit gate run | all | 09a–09g | `evidence/STAGE_09_GATE.md` |

### 2.1 Slice 09a — tenant control plane and first-party membership

**Goal.** Replace `AUTH_MEMBERSHIP_FILE` as the production membership source with a
database owned by `tenant-control-plane`, keeping the ADR-0014 verification order
(verify token first, then map `iss|sub`).

**Decisions restated.** R4's "likely answer" (first-party membership, IdP for
authentication only) is adopted as the working assumption; it needs owner
confirmation (D1). Roles stay `viewer | operator | admin | device`
(`packages/tenant-auth/src/index.ts:9`); `device` is not assignable to a human
membership. Add `owner` only by ADR (D7).

**Ownership move.** `tenants` currently lives in `greenguard_inventory`
(device-service). Follow docs/PLATFORM_CONTRACTS_AND_OPERATIONS.md line 29: control
plane becomes the single writer of `organizations`; device-service keeps its `tenants`
row as a projection populated from `greenguard.inventory.tenant.v1`, never written by
two owners. Migration order: (1) control plane creates organizations with IDs equal to
existing `tenant_id`s (backfill job, idempotent); (2) device-service stops accepting
tenant writes and consumes events; (3) reconciliation count check. The topic name keeps
the `inventory.tenant` prefix "through owner migration" (line 85).

**Behaviour.**

- Invitations: admin creates an invitation for an email + role; a single-use token
  (256-bit random, SHA-256 stored, 72 h expiry, OPEN: D7) is accepted by a signed-in
  identity; acceptance binds `iss|sub` to the organization. Email delivery reuses the
  Stage 06 notification path through the outbox; no direct SMTP from the request path.
- Last-admin protection: removing or demoting the last active admin is rejected `409`
  (pessimistic lock on the organization row, see §3.1).
- Membership changes (grant, role change, suspend, remove) write membership row +
  `audit_events` row + outbox `membership.changed` in one transaction.
- **Revocation propagation, bounded and fail-closed.** Verifiers (BFF, Read API, saga
  API, gateway) load memberships through a new `MembershipSource` interface in
  `packages/tenant-auth`, with two adapters: the existing file adapter (tests, Dex) and
  an HTTP/gRPC adapter to the control plane that serves a per-identity lookup with a
  short cache. Required bounds (initial values, to be measured):
  - positive cache TTL ≤ 30 s (matches ADR-0014's refresh default);
  - `membership.changed` consumer invalidates the cached entry on receipt (typical
    propagation = CDC lag, measured and reported p95/max);
  - lookup failure: keep last good entry until `MAX_STALE` (5 min, ADR-0014), then
    `401 invalid_claims` — never "allow on error";
  - negative results cached ≤ 5 s so a newly invited user is not locked out long.
  The gate states the measured worst case; the documented guarantee is
  `max(cache TTL, consumer lag)` with fail-closed after `MAX_STALE`.
- Access tokens are not revoked by the IdP in this model; membership removal makes the
  still-valid token useless within the bound above. Refresh-token revocation at the IdP
  is a 09g concern.
- Suspended organization (`tenant.suspended`): all principals of the tenant get `403`
  at the same enforcement points; ingest admission rejects via the Stage 04 binding
  feed pattern (device disable), not a new synchronous call.

**Tests (IDs M01–M12).** M01 two-tenant: an admin of A cannot list/modify B's members
(API + RLS). M02 invitation replay (same token twice) → one membership. M03 expired /
wrong-tenant token rejected. M04 concurrent last-admin removal → exactly one succeeds.
M05 role change reflected within bound (measured). M06 removed member denied at BFF,
Read API, saga API (reuse Stage 08 harness). M07 control-plane outage: cached members
continue ≤ MAX_STALE, then 401. M08 IdP-asserted `tenant_id` ignored. M09 every
membership change has exactly one audit row and one outbox row (crash before/after
commit). M10 device-service tenant projection converges and rejects direct writes.
M11 migration empty + upgrade. M12 runtime role has no UPDATE on audit and no DELETE
anywhere.

**Live target.** `make control-plane-e2e` (opt-in): Dex + control plane + BFF; invite,
accept, use, revoke, observe denial timing.

### 2.2 Slice 09b — API keys

**Decided.** X12 (COVERAGE_MATRIX line 145) requires a recorded choice between bcrypt
and SHA-256 digests of high-entropy keys, and states not to hash the same secret
twice. **Recommendation (ADR required):** 256-bit random keys, SHA-256 (or HMAC-SHA-256
with a server-side pepper held in the secret store; O1 touchpoint) stored digest,
constant-time compare, because bcrypt on every telemetry request conflicts with
ADR-0007's 1.67M readings/s arithmetic and high-entropy keys do not need slow hashing.

**Format.** `gg_<env>_<kind>_<keyid>_<secret>` where `kind ∈ {usr, dev}`, `keyid` is a
public lookup ID and the secret is shown once on creation. Prefix lets secret scanners
match (register with GitHub secret scanning later, Stage 12).

**Kinds.**

- *User/service keys*: tenant-scoped, scope list (`read:telemetry`, `write:devices`,
  `export:audit`, ...), never broader than the creating member's role; creator's
  membership removal disables the key (propagation same as 09a).
- *Device keys*: subject is exactly one device; can only write that device's readings
  (matches Q6 device tokens, ARCHITECTURE_REVIEW Stage 03 table). Ingest remains
  "authenticate, then rate limit, then parse" (ADR-0007). Device key revocation must
  also travel through the device binding feed so ingest's existing fail-closed
  freshness rule (ADR-0009) applies.

**Rotation.** Create new key, overlap window (default 24 h, configurable), old key
`expires_at` set; revocation is immediate at the owner and bounded at verifiers
(cache ≤ 30 s, same fail-closed rule). Revocation on cache hit is tested (X12).

**Per-key limits.** Add a `key` dimension to the ingest `Limiter` and the BFF bucket;
per-key limit ≤ tenant limit; a noisy key cannot consume the tenant bucket for other
keys (fairness test). Limits come from entitlements (09c).

**Tests (K01–K10).** K01 plaintext never stored or logged (grep logs in test). K02
wrong-tenant key denied. K03 device key cannot write another device. K04 scope
escalation rejected at creation. K05 revoked key denied within bound; K06 rotation
overlap both keys work, then old fails. K07 constant-time compare used (unit). K08
per-key 429 with Retry-After, writes no rows (ADR-0007 test list). K09 creator removal
disables key. K10 digest lookup p95 measured with L1 cache.

### 2.3 Slice 09c — entitlements and quotas

**Plan model.** A plan is a versioned set of typed limits and feature grants; a tenant
entitlement = plan version + per-tenant overrides + effective period. Initial limit
keys (OPEN catalog: D4):

| Key | Enforcement point | Mechanism | Failure mode |
|---|---|---|---|
| `devices.max` | device-service device registration (and saga provisioning start) | transactional count check under lock (§3.3) | reject `403 entitlement_exceeded` (hard) |
| `ingest.readings_per_month` | telemetry-ingest after auth, beside ADR-0007 limiter | local counter + periodic usage report; soft limit | per overage policy (D3) |
| `ingest.rate_per_device` / `per_tenant` | telemetry-ingest `Limiter` config | ADR-0007 token buckets parameterized by plan | 429 + Retry-After |
| `retention.days` | Cassandra TTL / read retention (ADR-0011) | applied at write time for new data | never deletes retroactively without O2 process |
| `history.range_days` | Read API query validation | reject longer range | `403 entitlement_exceeded` |
| `seats.max` | control plane invitation accept / role grant | transactional count under org-row lock | reject `409 seat_limit` |
| `api_keys.max` | control plane key issuance | same lock | reject |
| `exports.per_day` | 09e export request | counter | 429 |
| feature grants (e.g. `sso`, `audit_export`) | route guards | boolean | 403 |

**Relation to rate limits and R5.** Rate limits (ADR-0007, BFF buckets) protect the
system per second and are never waived by a plan; quotas meter commercial allowance per
period; R5 noisy-neighbour controls (statement timeouts, connection quotas, Read API
bulkheads from docs/STAGE_08_PLAN.md slice 3) protect shared cells and are also not
plan-waivable. A plan may *raise* a tenant's rate-limit parameters within a cell cap;
the cell cap remains an operator setting. Add per-tenant `statement_timeout` via role
or `SET LOCAL` in `withTenant` as part of R5 (09c closes R5's first half; Stage 13 owns
the hot-tenant load test).

**Distribution.** Billing (09d) is the source of `entitlements.changed` on
`greenguard.billing.lifecycle.v1`. A shared `packages/entitlements` library consumes it
into each enforcing service's local read table (inbox + version, idempotent). Services
never call billing synchronously on the hot path. Missing entitlement (new tenant not
yet projected, or consumer stale beyond bound): **fail to the free/default plan
limits, never to unlimited**; paid-tier-only features deny. Staleness bound and alert
like ADR-0009.

**Overage policy — OPEN DECISION D3.** Options: throttle (429 at limit), reject (hard
403), bill (accept and meter overage). **Recommendation:** hard reject for
`devices.max`, `seats.max`, `api_keys.max` (discrete, user-visible); soft limit with
grace (e.g. 110%) then throttle for ingest volume — **never drop an accepted reading
and never reject silently**; billed overage only after 09d reconciliation is proven.
Cost of being wrong: rejecting ingest loses customer grain-safety data (high harm);
billing overage without reconciliation risks incorrect invoices and disputes.

**Tests (E01–E10, prefix `ENT-` to avoid clashing with FIRST_VERTICAL_SLICE E01–E05).**
ENT-01 two concurrent device registrations at `max-1` → exactly one succeeds. ENT-02
entitlement upgrade raises limit after event; downgrade below current usage blocks new
creation but does not delete. ENT-03 duplicate/reordered `entitlements.changed` →
highest version wins. ENT-04 stale consumer → default plan limits, alert fired.
ENT-05 tenant A's entitlement never applies to B. ENT-06 history range enforced in Read
API and GraphQL. ENT-07 ingest soft limit → throttle with stable reason, no rows.
ENT-08 seat limit at invitation accept. ENT-09 plan version recorded on decisions.
ENT-10 per-tenant statement timeout fires on a synthetic slow query.

### 2.4 Slice 09d — billing-service, Stripe TEST MODE only

**Hard rules.** Test-mode keys only (`sk_test_`/`rk_test_` prefixes checked at startup;
a live key aborts startup). Keys supplied by the owner in the ignored `.env`; agents
never enter, request, invent or print credentials. No card data touches GreenGuard.

**Components.**

1. *Catalog*: products/prices defined as code in `services/billing-service/catalog/`
   and applied to Stripe test mode by an idempotent sync script (lookup keys, not IDs,
   in code). Local plan table mirrors lookup key → plan version.
2. *Customer mapping*: one Stripe customer per organization; `tenant_id` in Stripe
   metadata; mapping row created through the outbox-driven job (not in the request
   transaction), keyed by tenant with a Stripe idempotency key derived from
   `tenant_id` so retries never create duplicates.
3. *Checkout*: `/v1/billing/checkout` creates a Stripe-hosted Checkout Session
   (`mode=subscription`, `client_reference_id=tenant_id`, allow-listed return URLs).
   Customer Portal for payment-method changes and cancellation (P06). Session creation
   is an external call: record a `billing_commands` row + outbox first, call Stripe
   from a worker with idempotency key = command ID (no dual write).
4. *Webhook receiver* `/webhooks/stripe`: raw body; verify `Stripe-Signature` with the
   signing secret; reject timestamp outside tolerance (300 s default); support two
   active secrets during rotation (PLATFORM doc line 75); insert into
   `stripe_webhook_inbox` keyed by Stripe `event.id` (unique) and return 2xx only after
   commit; duplicate `event.id` → 2xx no-op. Processing is asynchronous from the inbox.
5. *Idempotent handling and ordering*: Stripe does not guarantee order. Handlers
   re-fetch the current object from the Stripe API (or compare `created` +
   object version) and apply only newer state; subscription state uses an optimistic
   `version` column. Every applied change writes subscription row + outbox
   `subscription.changed` / `entitlements.changed` in one transaction.
6. *Replay/redrive*: operator command re-queues inbox rows (by event ID or time range)
   with audit; replay of an already-applied event is a no-op; Stripe CLI / dashboard
   "resend" is also safe. Events that fail N times go to `status='quarantined'`, visible
   and alerting, mirroring the Stage 04 quarantine rule.
7. *Usage metering*: see OPEN D2 for what is metered. Usage flows: telemetry
   `telemetry.recorded` consumer (billing inbox) → `usage_ledger` rows aggregated per
   tenant/meter/hour with idempotent key `(tenant_id, meter, source_event_id)` or
   per-hour aggregate with contributing offset frontier. Period close locks the period
   row (pessimistic, §3.4), freezes the total, writes `usage_reports` with a
   deterministic idempotency key `(tenant_id, meter, period_start)`, and a worker sends
   it to Stripe meter events. A resend with the same identifier is not double counted.
   Late events after close go to the next period with a `late` flag (consistent with
   ADR-0006 lateness policy).
8. *Lifecycle and dunning states*: `incomplete → trialing|active → past_due → unpaid |
   canceled`; `canceled` at period end vs immediate; downgrade effective at period
   end by default. Dunning (Stripe Smart Retries) drives `past_due`; GreenGuard maps
   `past_due` to grace (full entitlements, banner) for a configurable window, then
   `unpaid` → free-plan limits (not data deletion). OPEN: grace length (D4).
9. *Reconciliation*: nightly (and on-demand) job lists Stripe subscriptions, invoices
   and meter summaries for the period and compares with local state; mismatches emit
   `billing.reconciliation_required` and a report; never auto-"fix" money, only state
   mirrors (subscription status) after re-fetch.

**Tests (B01–B16).** B01 bad signature → 400, nothing stored. B02 stale timestamp →
400. B03 duplicate event → one effect. B04 reordered `customer.subscription.updated`
before `created` → correct final state. B05 crash after inbox commit before processing
→ processed once on restart. B06 crash after Stripe call before recording result →
retry with same idempotency key, one Checkout Session / one customer. B07 cancel at
period end → entitlements drop at the boundary. B08 downgrade below usage → ENT-02
behaviour. B09 past_due → grace → unpaid state machine. B10 usage report idempotent on
resend. B11 period close concurrent with late usage → no lost or double-counted unit.
B12 reconciliation detects an injected mismatch. B13 tenant A webhook cannot mutate B
(metadata/customer mapping mismatch → quarantine). B14 live key rejected at startup.
B15 secret rotation overlap. B16 replay tool audited and no-op on applied events.

### 2.5 Slice 09e — audit export

**Source.** Existing `audit_events` per owning service (device-service today; control
plane and billing add their own). `packages/audit` becomes the shared envelope and
append-only adapter (its README responsibility). Audit remains owned per service
database; the export reads each owner's audit through a read role or its outbox
projection — no cross-service table writes.

**Recommendation:** a tenant-scoped audit projection in the read database, fed by
audit outbox events, so one export query spans owners. (OPEN minor: accept, or query
each owner. The projection is simpler and matches CQRS.)

**Export.**

- Synchronous `GET /v1/audit-events?cursor=` for small pages (keyset pagination on
  `(occurred_at, audit_id)`, max page 500), admin role + `audit_export` entitlement.
- Large export: `POST /v1/exports {type: audit, from, to, format: csv|jsonl}` → `202`
  with job ID; `jobs-worker` (Stage 06 RabbitMQ) streams rows, writes object to a local
  object-store abstraction (filesystem/MinIO locally; S3 in Stage 10), emits
  `export.ready` on `greenguard.jobs.lifecycle.v1`. Download via short-lived signed URL
  bound to tenant and job.
- **Verifiable**: each export has a manifest with row count, time range, SHA-256 of the
  file and a hash chain over rows; manifest signed with an Ed25519 export key held in
  the secret store (O1 key hierarchy touchpoint); public key published per environment;
  a `verify-audit-export` CLI checks it.
- **Redaction**: data classification (O2) tags fields; exports mask personal data
  (emails → hashed or partially masked) unless the requester has a privileged scope;
  secret-bearing fields (key digests, webhook payloads) never exported.
- **Retention**: audit retention period is OPEN (D8); exports expire after 7 days.
  The act of exporting is itself audited.

**Tests (A01–A08).** A01 export for A contains no B rows (RLS + filter). A02 pagination
stable under concurrent inserts. A03 signature verifies; tampered row fails. A04
redaction applied by role. A05 large export resumes after worker crash, single output.
A06 expired link denied. A07 export action audited. A08 viewer role denied.

### 2.6 Slice 09f — per-tenant feature flags

Implement `packages/feature-flags` as the OpenFeature port (PLATFORM §9 line 255):

- Evaluation context carries `tenantId` (from verified principal only), plan, cell,
  role; never from request input.
- Providers: local static JSON provider (tests/dev) and a control-plane provider backed
  by a `flag_configurations` table owned by the control plane, distributed via
  `flag.configuration_changed` on `greenguard.platform.config.v1` into a local cache.
  DynamoDB adapter deferred to Stage 10 (README).
- Typed defaults per flag defined in code; provider error or stale cache → default
  (safe = feature off / conservative behaviour). Kill switches stop optional work but
  never bypass auth, outbox or receipts.
- Record flag configuration version on decisions affecting billing or scoring.
- Rollout changes audited (P13 "rollout audit").

**Tests (F01–F06).** F01 tenant A override does not affect B. F02 provider down →
typed default. F03 stale beyond bound → default and alert. F04 kill switch stops new
optional sends, queued work preserved. F05 change audited with actor. F06 tenant cannot
be spoofed via headers.

**OPEN (minor):** OpenFeature SDK choice and pin (`@openfeature/server-sdk`, Go SDK);
must be added to docs/TECHNOLOGY_CATALOG.md as a new family (AGENTS.md "Before opening
a PR").

### 2.7 Slice 09g — SSO / Auth0 path (authentication only)

- `packages/tenant-auth` gains a multi-issuer allow-list: `(issuer, audience,
  jwks_url)` records, each mapped through the same membership lookup. No token from an
  unlisted issuer verifies. Keep RS256-only and all ADR-0014 checks.
- Control plane `identity_connections` table: per-tenant optional enterprise
  connection (OIDC or SAML via the IdP) with verified email domains; home-realm
  discovery by email domain; JIT membership only if the tenant admin enabled it and
  the domain is verified, with default role `viewer`.
- Auth0 used as a plain OIDC provider: one Auth0 tenant, one application, **no Auth0
  Organizations per GreenGuard tenant** (R4: 100,000 organizations per Auth0 tenant vs
  10M target). Enterprise SAML/OIDC connections are per enterprise customer, not per
  tenant, and their count is itself a provider limit (Z07) — see D1.
- Refresh-token revocation: on membership removal, call the IdP's revoke endpoint via
  an outbox-driven worker (best effort; the membership bound in 09a is the guarantee).
- Keep Dex for all automated tests; add a second Dex instance (different issuer) to
  prove multi-issuer isolation locally.

**Local vs real account.**

| Provable locally with Dex / fakes | Needs owner's real Auth0 dev tenant |
|---|---|
| Multi-issuer allow-list, issuer confusion rejection | Auth0 discovery/JWKS/claims format against the real service |
| Membership mapping, JIT rules, domain verification logic (with fake DNS/TXT verifier) | Auth0 enterprise SAML/OIDC connection round trip |
| PKCE login, refresh, logout behaviour (Dex) | RP-initiated logout (`end_session_endpoint`), `prompt=none` silent auth |
| Revocation bound (membership side) | Refresh-token revocation API behaviour and rate limits |
| Failure: JWKS down, key rotation | Tenant-level Auth0 rate limits / MAU quotas (Z07) |

Owner-run script: `make auth0-sandbox-check` reads `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`,
`AUTH0_AUDIENCE` (and a test user set up by the owner) from `.env`; agents do not run it
without those values and never create the Auth0 account.

**Tests (S01–S07).** S01 unlisted issuer rejected. S02 same `sub` under two issuers maps
to two different identities. S03 IdP `tenant_id` claim ignored. S04 JIT off → 401 for
unknown identity. S05 JIT on + verified domain → viewer only. S06 domain unverified →
no JIT. S07 connection belonging to tenant A cannot grant B.

## 3. Data model sketches

Common to every table below (CLAUDE.md invariants): `tenant_id uuid NOT NULL`,
`ENABLE` + `FORCE ROW LEVEL SECURITY` with a policy on
`current_setting('app.tenant_id', true)::uuid`, composite PK/FK `(tenant_id, id)`,
migrations run by an owner role, runtime role non-owner with **no DELETE** grant (and
no UPDATE on append-only tables), tenant set with `set_config('app.tenant_id', $1,
true)` per transaction, outbox row in the same transaction for every domain change.
Concurrency choices follow ADR-0002 and are to be repeated as a comment in each
migration.

### 3.1 tenant-control-plane (`greenguard_control` database, new)

| Table | Key columns | Concurrency | Notes |
|---|---|---|---|
| `organizations` | `tenant_id` PK, `name`, `state` (active/suspended/deleting), `home_region`, `cell_id`, `routing_epoch`, `version` | optimistic `version` for edits; `SELECT … FOR UPDATE` on the row for seat/last-admin checks | placement columns from PLATFORM doc line 29; RLS: tenant row visible to itself; platform-admin role separate and audited |
| `identities` | `identity_id` PK, `issuer`, `subject`, unique `(issuer, subject)` | insert-only | **not tenant-scoped** (one person, many tenants); no personal data beyond email hash; exception documented in ADR, access via a narrow lookup function |
| `memberships` | `(tenant_id, identity_id)` PK, `role`, `state`, `version`, `granted_by`, timestamps | optimistic `version` + 409; seat/last-admin paths take org-row lock first (lock order: organization → membership) | FK `(tenant_id)` → organizations; soft state, no DELETE |
| `invitations` | `(tenant_id, invitation_id)`, `email_hash`, `role`, `token_digest` unique, `expires_at`, `accepted_at`, `accepted_identity_id` | acceptance `UPDATE … WHERE accepted_at IS NULL` (single-use, atomic) | token digest only |
| `api_keys` (09b) | `(tenant_id, key_id)`, `kind`, `device_id` nullable (composite FK to device projection), `scopes text[]`, `digest`, `created_by`, `expires_at`, `revoked_at`, `version` | optimistic `version`; revoke is idempotent | digest unique; no plaintext |
| `identity_connections` (09g) | `(tenant_id, connection_id)`, `issuer`, `type`, `verified_domains`, `jit_enabled`, `version` | optimistic | |
| `flag_configurations` (09f) | `(scope, flag_key)`, `tenant_id` nullable for global, `value jsonb`, `config_version` | optimistic | global rows readable by all tenants via a separate policy |
| `command_receipts`, `outbox_events`, `audit_events` | as in device-service | receipts: unique idempotency key | same shape as `services/device-service/prisma/schema.prisma` |

### 3.2 packages/entitlements local tables (one per enforcing service database)

`tenant_entitlements(tenant_id PK, plan_key, plan_version, limits jsonb,
features text[], source_version bigint, applied_at)` — updated only by the entitlement
consumer when `source_version` is higher (optimistic monotonic apply); plus the service's
existing `consumer_inbox`. RLS forced; runtime role SELECT only, consumer role
UPDATE/INSERT.

### 3.3 device-service additions

Device-count enforcement: registration transaction takes `SELECT … FOR UPDATE` on the
tenant projection row (`tenants`), counts active devices, compares with
`tenant_entitlements.limits->>'devices.max'`, inserts. Pessimistic because it is hot
single-row contention per tenant during bulk provisioning (ADR-0002 table). The saga
reserve step (Stage 07) must use the same check to avoid a bypass.

### 3.4 billing-service (`greenguard_billing` database, new)

| Table | Key columns | Concurrency |
|---|---|---|
| `billing_customers` | `(tenant_id)` PK, `stripe_customer_id` unique, `version` | optimistic |
| `subscriptions` | `(tenant_id, subscription_id)`, `stripe_subscription_id` unique, `status`, `plan_key`, `current_period_start/end`, `cancel_at_period_end`, `stripe_object_created`, `version` | **optimistic `version`** + monotonic Stripe timestamp guard |
| `billing_commands` | `(tenant_id, command_id)`, `type`, `status`, `stripe_idempotency_key`, `result` | receipt pattern; unique idempotency key |
| `stripe_webhook_inbox` | `event_id` PK (Stripe ID), `tenant_id` nullable until resolved, `type`, `payload` (encrypted column, O1), `received_at`, `status`, `attempts`, `last_error` | insert-unique; worker claims with `FOR UPDATE SKIP LOCKED` |
| `usage_ledger` | `(tenant_id, meter, period_start, bucket_hour)` PK, `quantity`, `source_frontier`, `version` | upsert with `ON CONFLICT` increment inside the consumer's inbox transaction |
| `usage_periods` | `(tenant_id, meter, period_start)`, `state` (open/closing/closed/reported), `total`, `report_idempotency_key` | **pessimistic `FOR UPDATE`** on close (money path; ADR-0002 "money/quotas → serializable or FOR UPDATE with NOWAIT/timeout") |
| `reconciliation_runs` / `reconciliation_findings` | run ID, tenant, object, local vs remote, status | insert-only |

`stripe_webhook_inbox` is not tenant-scoped at insert (the tenant is unknown until the
event is resolved); it lives in a schema readable only by the webhook role, and the
resolved tenant is copied to tenant-scoped tables. This exception needs an ADR line.

### 3.5 Events (outbox → Debezium → canonical transformer, no direct publish)

| Event | Topic (existing name) | Key | Payload highlights | Consumers |
|---|---|---|---|---|
| `tenant.created` / `tenant.updated` / `tenant.suspended` | `greenguard.inventory.tenant.v1` | `tenant_id:tenant_id` | state, placement epoch | device-service projection, billing, read |
| `membership.changed` | same | `tenant_id:identity_id` | identity_id, role, state, version — **no email** (line 85: restrict membership payload access) | verifiers' cache invalidation, audit projection |
| `api_key.changed` | same (new type, reviewed addition) | `tenant_id:key_id` | kind, scopes, revoked_at, version | ingest/BFF key caches |
| `subscription.changed` | `greenguard.billing.lifecycle.v1` | `tenant_id:subscription_id` | status, plan, period, version | views, audit |
| `entitlements.changed` | same | `tenant_id:tenant_id` | plan_version, limits, features, source_version | `packages/entitlements` consumers |
| `usage.accepted` | same | `tenant_id:meter:period` | meter, period, quantity, report key | views, audit (the brief's `usage.recorded` maps to this existing name) |
| `billing.reconciliation_required` | same | `tenant_id:finding_id` | object refs, diff class | operators, alerts |
| `flag.configuration_changed` | `greenguard.platform.config.v1` | `scope:flag_key` | config_version | flag caches |
| `export.ready` | `greenguard.jobs.lifecycle.v1` | `tenant_id:job_id` | manifest hash, expiry | notification |

JSON Schemas go in `contracts/events/` with fixtures, following ADR-0010 headers
(`event_id`, `event_type`, `schema_version`, `tenant_id`, `correlation_id`,
`traceparent`) and the H5 rule (aggregate_id equals the payload's identity field),
validated in both validators. Topic provisioning is added to `scripts/kafka-topics.mjs`
by one slice owner only (§9) to avoid collisions. Each new outbox database needs its
own Debezium connector/slot (FIRST_VERTICAL_SLICE line 24) and must be covered by the
open H3 WAL/slot alerting work.

## 4. Security and privacy

1. **Secrets.** Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_WEBHOOK_SECRET_PREVIOUS`) and Auth0 (`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`,
   `AUTH0_CLIENT_SECRET` if a confidential client is used) are placeholders in
   `.env.example` only; real values are supplied by the owner into the ignored `.env`.
   Agents must never enter, invent, request in chat, print or commit credentials. CI
   uses stripe-mock and Dex (no secrets). Startup rejects live-mode keys. Logs redact
   `Authorization`, `Stripe-Signature`, key material. Deployment path: External Secrets
   (PLATFORM doc line 75).
2. **PCI scope minimization.** Stripe-hosted Checkout and Customer Portal only; no
   card fields, Elements or card tokens in GreenGuard; target SAQ A. Billing stores
   Stripe IDs and statuses only.
3. **Webhooks.** Raw-body HMAC verification before JSON parse, timestamp tolerance,
   unique `event.id` inbox (replay protection), 2xx only after commit, dual secret
   during rotation, narrow route with body size cap, no tenant derived from anything but
   the stored customer mapping.
4. **API keys.** One-time disclosure, digest at rest (+ pepper in secret store),
   constant-time compare, prefixes for scanning, expiry, revocation-on-cache-hit.
5. **Tenant deletion / personal data (O2).** 09a adds a data classification register
   (`docs/DATA_CLASSIFICATION.md`, created by 09a) for identities, invitations, audit,
   billing. Deletion is a control-plane workflow: `organizations.state=deleting` →
   `tenant.suspended` → per-owner deletion hooks (each owner implements a
   `tenant.deletion_requested` handler later) → Stripe customer deletion via worker →
   proof record. Stage 09 implements the workflow skeleton and the hooks for its own
   tables; full cross-store crypto-shred and backup proof is Stage 14. Personal data in
   events is minimized (identity IDs, not emails).
6. **Encryption key hierarchy (O1).** Touchpoints: API-key pepper, audit-export
   signing key, envelope-encrypted columns (`stripe_webhook_inbox.payload`,
   invitation email). Locally a key file from `make bootstrap` (ignored); production
   per-environment KMS keys with rotation (Stage 12). Record in an ADR.
7. **Authorization.** Every route: verified principal → membership → role → entitlement
   → tenant-scoped query (AGENTS.md rule 1: RLS plus app filter). Deny cross-tenant with
   the consistent `403/404` choice (PLATFORM §4).

## 5. Test plan mapped to the exit gate

| Exit-gate clause | Automated (in `make verify`, no network, fakes) | Live-stack script (opt-in, not in `make verify`) | Needs owner accounts |
|---|---|---|---|
| Sandbox purchase flow correct | B06, B14, checkout command/outbox unit tests against stripe-mock | `make billing-e2e`: stripe-mock + local signer drives checkout.session.completed → subscription active → entitlements.changed → device limit raised | `make stripe-sandbox-check`: real test-mode Checkout completed with Stripe test card by the owner in a browser; Stripe CLI `listen --forward-to` |
| Webhook correct | B01–B05, B13, B15 | signer script sends valid/invalid/duplicate/reordered events | real Stripe signature format and retry schedule |
| Replay correct | B16, B03 | redrive tool on quarantined and applied events | Stripe dashboard/CLI resend |
| Cancel correct | B07–B09 | scripted `customer.subscription.updated/deleted` sequences | portal cancellation by the owner |
| Metering (implied by backlog) | B10–B11 | usage consumer + period close + fake meter endpoint | real meter event acceptance and invoice preview |
| Membership revocation works | M04–M09, K05, K09, S01–S07 | `make control-plane-e2e` with Dex: revoke and measure denial latency at BFF/Read API/saga | Auth0 refresh-token revocation (09g) |
| Tenant-scoped entitlements proven | ENT-01..10, two-tenant tests | entitlement upgrade/downgrade flows through Kafka | — |
| Tenant-scoped audit proven | A01–A08, M09, M12 | large export job with worker crash | — |
| Flags (backlog deliverable) | F01–F06 | — | — |

**Fake harness (so most of the gate is provable without accounts).**

- `stripe/stripe-mock` (pinned by digest) for API shape of customers, checkout
  sessions, subscriptions; it is stateless, so lifecycle is driven by
- a scripted **webhook signer** (`services/billing-service/test/stripe-signer.ts`)
  that builds events from checked-in fixtures and signs them with the test secret
  using Stripe's documented `t=…,v1=HMAC_SHA256(secret, t.payload)` scheme; tests also
  verify with the official SDK `constructEvent` to prove format compatibility;
- a **fake meter endpoint** recording usage submissions to assert idempotency;
- Dex (two issuers) plus a fake DNS verifier for SSO domain checks.

**What agents cannot prove alone:** real Stripe test-mode Checkout completion (needs a
browser session and the owner's test account/keys), real Stripe webhook delivery/retry
timing, real meter/invoice computation, tax/currency behaviour, Auth0 tenant behaviour
(discovery, SAML connections, logout, refresh revocation, rate limits/MAU quotas). These
produce owner-run evidence files and are listed as such in `STAGE_09_GATE.md`.

## 6. Infra and CI

- New opt-in compose files: `infra/billing/compose.yaml` (stripe-mock ~30 MB,
  billing-service), `infra/control-plane/compose.yaml` (control plane; reuses the main
  Postgres with a new logical database and roles added to
  `infra/compose/init-databases.sql` — shared file, one owner, §9), second Dex issuer
  in `infra/oidc/compose.yaml` (shared file, 09g owner).
- New Make targets (not in `make verify`): `control-plane-e2e`, `billing-e2e`,
  `audit-export-e2e`, owner-only `stripe-sandbox-check`, `auth0-sandbox-check`.
- CI: separate opt-in jobs `stage09-billing-fakes` and `stage09-control-plane` on
  `workflow_dispatch` and a path filter; required-gate membership decided by the owner
  (docs/CI_CD.md). No job uses real Stripe/Auth0 secrets; untrusted PRs never get
  secrets (`.coderabbit.yaml` workflow checks).
- **Laptop memory budget (incremental over the Stage 04–08 stack):** control plane
  ~150 MB, billing ~150 MB, stripe-mock ~30 MB, second Dex 128 MB (ADR-0014 limit),
  jobs worker reused. Target ≤ 500 MB extra; run the billing and control-plane profiles
  without Cassandra/Elasticsearch where tests allow.

## 7. Capacity (all UNMEASURED)

Tier 1 (docs/CAPACITY_MODEL.md lines 12–17): 100,000 users, 10,000 concurrent,
10,000 organizations in one cell, 1,000,000 devices, 20,000 events/s normal, 50,000
peak.

| Path | Derived rate | Design consequence |
|---|---|---|
| Usage metering | 20k–50k telemetry events/s must not become 20k–50k billing writes/s | aggregate in memory per consumer partition and flush per tenant/meter/hour with the offset frontier committed in the same transaction: ≤ 10,000 tenants × meters rows per flush interval (e.g. 10k rows/min ≈ 170 writes/s) |
| Stripe usage reporting | one report per tenant per meter per period (or hourly) | 10,000 hourly reports ≈ 2.8/s; within documented Stripe test-mode rate limits (must be verified by owner, UNMEASURED) |
| Entitlement checks | on every ingest request | local in-process lookup from `tenant_entitlements` cache; zero network calls on the hot path |
| Membership lookups | 10k concurrent users; with 30 s cache ≈ ≤ 333 lookups/s cold | control plane read path sized for this plus invalidation bursts |
| API-key verifies | per request | L1 cache by key ID, digest compare; DB lookup only on miss |
| Webhooks | low (≪ 10/s) at Tier 1 | single worker adequate; SKIP LOCKED for horizontal scale |

Tier U (10M orgs) needs the sharded tenant directory (SCALE doc line 50) and
per-cell billing consumers; not certified in Stage 09.

## 8. Risks and OPEN DECISIONS (ordered)

| # | Decision / risk | Recommendation | Cost of being wrong |
|---|---|---|---|
| D1 | **Identity provider limits (R4, Z07).** Auth0 caps organizations at 100,000 per tenant; 10M target. | Adopt first-party membership (09a) with the IdP for authentication only; no Auth0 Organization per tenant; enterprise SSO connections only for customers who buy SSO; confirm connection/MAU limits with the provider before Stage 12. Record as ADR accepting ADR-0014 plus this. | Using Auth0 Organizations forces an identity migration at ~100k tenants; first-party costs us invitations/UI we must build and secure. |
| D2 | **What is metered.** | Meter accepted readings per tenant per month and active devices (peak or monthly count); do not meter API calls initially. | Metering the wrong unit means repricing and migrating historical ledgers; metering too many units multiplies reconciliation work. |
| D3 | **Overage policy.** | Hard limits for discrete resources; soft limit + throttle for ingest; never drop accepted readings; billed overage only after reconciliation proven. | Rejecting ingest can hide grain-spoilage risk; billing without reconciliation risks wrong invoices. |
| D4 | **Plan catalog and grace periods.** | Three plans (Free, Standard, Enterprise) as code with lookup keys; 14-day past_due grace. Owner supplies numbers. | Cheap to change before launch if catalog is code; expensive after customers subscribe. |
| D5 | **Currency and tax.** | Single currency (USD or owner's choice); Stripe Tax deferred; prices tax-exclusive; record tax as OPEN legal item. | Adding currencies later needs new prices per currency; tax mistakes are legal exposure — owner/accountant decision, not engineering. |
| D6 | **Enforcement location while `services/gateway` is a README.** | Enforce in owning services (device-service, ingest, Read API, BFF) through `packages/entitlements`; gateway later adds coarse checks only. | Gateway-only enforcement would be bypassed by internal callers; service enforcement duplicates a little code. |
| D7 | **Role model additions** (`owner`, `billing_admin`), invitation expiry. | Add `billing_admin` scope only if needed; keep four roles; 72 h expiry. ADR if roles change. | Role changes touch every `requireRole` call site and the membership contract. |
| D8 | **Audit retention and export redaction defaults.** | Retain audit 1 year hot + archive (agricultural, not healthcare periods; X13); mask emails by default. | Too short loses evidence for disputes; too long increases O2 deletion scope. |
| D9 | **Refunds, disputes, invoices ownership.** | Stripe owns invoices, refunds and disputes (dashboard operations by the owner); GreenGuard mirrors `invoice.*` and `charge.dispute.*` status read-only and audits them; no refund API in Stage 09. | Building refunds early adds a money-moving path needing controls; mirroring only keeps scope small. |
| D10 | **Data residency (O3).** | Record "tenants pinned to one home region" in the placement model now (`organizations.home_region`), single region implemented; Stripe/Auth0 data location reviewed by owner. | Adding residency later requires tenant relocation workflows and provider region changes. |
| R-a | Tenant ownership migration from device-service creates two writers | one-writer cutover with reconciliation (§2.1) | split-brain tenant state |
| R-b | Stripe event ordering/replay causes wrong entitlements | re-fetch + version guard + reconciliation | customers lose or gain access wrongly |
| R-c | New Debezium slots add WAL risk (H3 open) | do not start 09 connectors in shared envs until H3 alerts exist | disk exhaustion |
| R-d | Owner-only evidence blocks the gate | schedule owner sessions early; fakes cover the rest | stage stalls at the last step |

## 9. Work breakdown and parallelism

**Sequential spine:** 09a (control plane + `MembershipSource`) → then 09b, 09e, 09f,
09g in parallel → 09c after 09a and after 09d's `entitlements.changed` schema is
merged (09c can start on a static-plan provider) → 09d in parallel with 09b–09g once
09a's tenant topic exists → Gate.

**Shared files (single owner, others submit changes through that owner or wait):**

| Shared file | Owner slice |
|---|---|
| `packages/tenant-auth/src/*` | 09a first; then 09b (key verifier module in its own file), 09g (issuer config in its own file) sequentially after 09a merges |
| `scripts/kafka-topics.mjs`, `scripts/kafka-connect.mjs` | 09a (adds all Stage 09 topics/connectors at once, including billing) |
| `infra/compose/init-databases.sql`, `infra/compose/pgbouncer/pgbouncer.ini` | 09a (adds `greenguard_control` and `greenguard_billing` roles/databases together) |
| `.env.example` | 09a (adds all Stage 09 placeholders, empty) |
| `Makefile`, `.github/workflows/ci.yml` | gate integrator, one PR at the end of each slice |
| `services/telemetry-ingest/ratelimit.go`, `auth.go` | 09b then 09c, sequential |
| `services/device-service/src/inventory/repository.ts` | 09c only |
| `docs/TECHNOLOGY_CATALOG.md`, `docs/MILESTONES.md` | gate integrator (MILESTONES only with evidence) |

**New directories/files per slice (no collisions):**

- 09a: `services/tenant-control-plane/{package.json,src/,prisma/,test/,CLAUDE.md}`,
  `contracts/events/{tenant-created,tenant-updated,tenant-suspended,membership-changed}.v1.schema.json`
  + fixtures, `packages/tenant-auth/src/membership-source.ts`,
  `infra/control-plane/compose.yaml`, `docs/adr/0016-first-party-membership.md`,
  `docs/DATA_CLASSIFICATION.md`, `evidence/STAGE_09A_VALIDATION.md`.
- 09b: `services/tenant-control-plane/src/api-keys/`,
  `packages/tenant-auth/src/api-key.ts`, `services/telemetry-ingest/apikey.go`
  (+ `_test.go`), `contracts/events/api-key-changed.v1.schema.json`,
  `docs/adr/0017-api-key-hashing.md`, `evidence/STAGE_09B_VALIDATION.md`.
- 09c: `packages/entitlements/{package.json,src/,go/}`,
  `contracts/events/entitlements-changed.v1.schema.json` (authored with 09d, merged by
  09d owner), `services/read-api/src/entitlements/` (adapter),
  `services/telemetry-ingest/entitlements.go`, `docs/adr/0018-quotas-and-overage.md`,
  `evidence/STAGE_09C_VALIDATION.md`.
- 09d: `services/billing-service/{package.json,src/,prisma/,catalog/,test/,CLAUDE.md}`,
  `contracts/events/{subscription-changed,usage-accepted,billing-reconciliation-required}.v1.schema.json`,
  `infra/billing/compose.yaml`, `docs/runbooks/billing-webhooks.md`,
  `docs/adr/0019-billing-stripe-test-mode.md`, `evidence/STAGE_09D_VALIDATION.md`.
- 09e: `packages/audit/{package.json,src/}`,
  `services/tenant-control-plane/src/audit-export/`,
  `services/jobs-worker/<audit-export handler dir>` (check jobs-worker layout first),
  `tools/verify-audit-export/`, `evidence/STAGE_09E_VALIDATION.md`.
- 09f: `packages/feature-flags/{package.json,src/}`,
  `contracts/events/flag-configuration-changed.v1.schema.json`,
  `services/tenant-control-plane/src/flags/`, `evidence/STAGE_09F_VALIDATION.md`.
- 09g: `packages/tenant-auth/src/issuers.ts`,
  `services/tenant-control-plane/src/connections/`, `infra/oidc/dex-second.yaml.tpl`,
  `scripts/auth0-sandbox-check.mjs`, `evidence/STAGE_09G_VALIDATION.md`.

**Parallel-safe groups after 09a merges:** {09b, 09d, 09e, 09f} can run as separate
agents (distinct directories; 09b and 09e both touch
`services/tenant-control-plane/src/` but in separate subdirectories and must rebase on
the shared module registration file, owned by 09a). 09g waits for 09b's changes to
`packages/tenant-auth` to merge. 09c follows 09b (ingest files) and needs 09d's schema.

Every slice: run `architecture-guard` before and after, `tenant-isolation-reviewer` on
all migrations and queries, `coderabbit review`, `make verify`, `make coverage`, and
save its evidence file before claiming the gate.
