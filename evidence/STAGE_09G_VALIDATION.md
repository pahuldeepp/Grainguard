# Stage 09g multi-IdP/SSO validation (2026-09-25)

## Implemented

- Multi-issuer OIDC verification is configurable through a bounded `AUTH_ISSUERS_JSON` list, with the legacy single-issuer settings retained. Issuer and JWKS URLs require HTTPS except for loopback development endpoints; malformed, duplicate, mixed legacy/multi-issuer and unsafe configurations fail closed.
- Tenant identity connections support verified-domain discovery, administrator-managed JIT membership, connection-level JIT enable/disable, and tenant-scoped persistence with forced RLS. An unverified email/domain cannot create a membership, and issuer identity is resolved to tenant membership by the control plane rather than trusted from token claims.
- Connection changes emit a strict `identity_connection.changed` v1 event without issuer/domain/PII fields. CDC validates the schema and aggregate identity, accepts it only from the control-plane outbox, and routes it to the tenant lifecycle stream.

## Local validation

- Control-plane suite with local PostgreSQL: `node --env-file=../../.env --test --test-concurrency=1 'dist/**/*.test.js'` — **50 passed, 0 failed, 2 skipped**. S04–S07 live DB tests passed for disabled JIT, verified-domain JIT, unverified-domain/email denial, tenant isolation, and RLS/no-delete grants.
- `node --env-file=.env scripts/oidc-multi-live.mjs` — passed against two local Dex issuers; the same subject is resolved to distinct tenants according to issuer.
- `npm test -w @greenguard/contracts` — **23 passed, 0 failed**.
- `go test ./...` in `services/cdc-transformer` — passed, including identity-connection source ownership, valid route and aggregate-version mismatch rejection.
- Control-plane typecheck passed after multi-issuer, audit-owner configuration and connection wiring.

## Remaining external proof

Local Dex proves the protocol flow but does not exercise a production IdP tenant. Production issuer registration, client configuration, key rotation, domain ownership and callback URLs must be supplied and verified in the deployment environment. Full Stage 09 CI, coverage, Sonar and CodeRabbit gates remain stage-wide work.

## Review hardening (F3, 2026-09-25)

Migration `20260925181000_identity_domain_expiry` (forward-only, applied with
`prisma migrate deploy`): `verified_until` (default 30 days; `IDENTITY_DOMAIN_TTL_DAYS`
1-365), `status` (`active`/`released`, no DELETE grant), partial unique index on
active claims replacing `UNIQUE(domain)`, `release_expired_domain()` and
`find_jit_tenant`/`discover_identity_realm` requiring an active, unexpired claim.
New routes: `POST .../connections/:id/domains/:domain/reverify` (re-checks DNS TXT,
a failed check changes nothing) and `.../release` (owner-tenant admin only).
`/v1/identity/discover` has a per-IP token bucket (`IDENTITY_DISCOVER_BURST`,
`IDENTITY_DISCOVER_PER_MINUTE`, bounded map, 429 + Retry-After); an edge limit is
still required in production. Invitations are bound to the verified email of the
accepting principal (403 `invitation_email_mismatch`); JIT enforces `seats.max`;
seed keys split on the first `|`.

Tests written first (compile-red, then green): DX1-DX5 (expired claim stops JIT,
re-verify extends, another tenant claims after expiry, cross-tenant release denied,
JIT seat limit), M20 (forwarded token), discovery throttle, token bucket, seed
`auth0|abc`. Run with `node --test` on the built `dist` files: identity-connections,
store, seed, rate-limit, discover-throttle and api tests all pass. A full-suite run
had 4 failures in another fixer's entitlement-feed tests (they pass in isolation).
Not verified: a live DNS TXT re-check. The JIT seat-limit denial audit gap was
closed in migration `20260925200000_jit_seat_denial_audit`: a denied, unmembered
identity is represented by a `membership_events` row with `identity_id = NULL`,
the deterministic identity UUID as actor, action `jit_seat_limit_denied`, the
entitlement version and request correlation ID. This uses the existing audit
table and export query; it does not persist the email or IdP subject. The DX5
live test confirms the seat-limit error, no membership creation, and one matching
audit row. `npm run build -w @greenguard/tenant-control-plane` and the focused
DX5 test pass. The full control-plane suite still has 21 failures in audit-export
quota/storage tests and API-key revocation; DX5 itself passes.
