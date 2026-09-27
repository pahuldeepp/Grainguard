# Stage 09e audit export validation (2026-09-25)

## Implemented

- Authenticated, tenant-scoped audit list and asynchronous export endpoints. Only tenant admins with the `audit_export` entitlement can list/request/status/download exports.
- Keyset pagination over control-plane membership/export actions and owner-read adapters for inventory and billing. The owner adapters use their own application roles, read-only transactions, tenant session context and forced RLS.
- JSONL and CSV exports use allowlisted fields, redact email in unprivileged exports, stream rows, and publish the data, Ed25519-signed manifest and signature atomically. The verifier checks the signature, file digest, row count and hash chain.
- Durable export jobs use a database lease and reclaim expired work after a crash. Reprocessing a completed job ID verifies and reuses its signed output. Download links are HMAC-bound to tenant, job and actor, expire within five minutes, and are also behind normal identity authentication. Successful downloads append an audit action.
- A worker command is available as `make audit-export-worker`; it requires the control, inventory and billing runtime database URLs plus export signing key material in ignored `.env`.

## Local validation

- `npm run typecheck -w @greenguard/tenant-control-plane` — passed after wiring owner database adapters and shutdown cleanup.
- `node --env-file=../../.env --test --test-concurrency=1 'dist/**/*.test.js'` from `services/tenant-control-plane` — **50 passed, 0 failed, 2 skipped**. The skips are opt-in process-crash M09 and an optional Kafka verifier test; the dedicated M09 crash test is recorded in [Stage 09a evidence](STAGE_09A_VALIDATION.md).
- Live audit checks passed: tenant isolation and role/entitlement denial; bounded cursor paging; control, inventory and billing reads under tenant RLS; foreign-tenant exclusion; JSONL and CSV signature verification; sensitive billing detail exclusion; worker lease reclaim after an injected crash; stable job identity/output; actor/tenant/job-bound expiring download tokens.
- The audit package's tests and coverage were previously recorded as 6/6 tests, 96.72% statements and 86.84% branches after the durable retry changes. Stage-wide coverage and Sonar are still pending.
- `git diff --check` passed.

## Operational configuration

When enabling the API, configure the export directory, public key and link secret together, plus `INVENTORY_DATABASE_URL` and `BILLING_DATABASE_URL`; the worker additionally needs `AUDIT_EXPORT_PRIVATE_KEY_PEM` and `AUDIT_EXPORT_PUBLIC_KEY_ID`. Owner database URLs must use the least-privileged application roles. No production IdP or audit-signing key was provisioned in this local test run.
