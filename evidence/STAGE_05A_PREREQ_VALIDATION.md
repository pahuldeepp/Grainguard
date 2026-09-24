# Stage 05a prerequisite validation — 2026-09-24

Scope: H6 facility contracts, transactional site/bin creation, explicit transformer
routing, topic declaration, API/backlog and accepted ADR-0010 documentation.
No commits or pushes. This records offline checks only and does not mark Stage 05
or its live acceptance gates complete.

## Checks actually run

- `cd services/cdc-transformer && GOFLAGS=-mod=mod go vet ./... && GOFLAGS=-mod=mod go test -race -cover ./...`: passed. Actual test summary:
  `ok greenguard.local/cdc-transformer 4.084s coverage: 100.0% of statements`.
- `npm test -w packages/contracts`: passed, 13 tests, 13 pass, 0 fail; includes TypeScript build.
- `npm run typecheck -w packages/contracts`: passed.
- In `packages/contracts`, `node --experimental-test-coverage --test 'dist/**/*.test.js'`: 13/13 pass; `dist/index.js` and all-files coverage: lines 100.00%, branches 100.00%, functions 100.00%.
- `npm test -w services/device-service`: build (including dependency builds and Prisma client generation) passed; test run failed: 112 tests, 42 pass, 64 fail, 6 cancelled, 0 skipped. The four new facility unit tests passed. Database fixtures lacked `INVENTORY_DATABASE_URL`, `INVENTORY_DIRECT_URL`, `INVENTORY_MIGRATION_URL` and `POSTGRES_ADMIN_URL`; listener-based tests hit `listen EPERM: operation not permitted 127.0.0.1`.
- `npm run typecheck -w services/device-service`: passed, including Prisma generation.
- Pure device-service subset: `npx c8 --reporter=text --reports-dir=/tmp/device-pure-source-coverage --exclude='**/*.test.*' --exclude='**/generated/**' --exclude='**/testing/**' node --test services/device-service/dist/config.test.js services/device-service/dist/api/versioning/policy.test.js services/device-service/dist/inventory/facility.unit.test.js`: 29 tests, 29 pass, 0 fail. Loaded production-source subset coverage: statements/lines 63.76%, branches 91.40%, functions 48.78%; repository.ts lines 51.24%, branches 77.77%. This is not full-service coverage and does not establish the 80% gate.
- `npm run lint` and `npm run lint -- --quiet`: passed. Final scoped ESLint for contracts and topic script also passed.
- Prettier on changed TypeScript/JSON/JavaScript and documentation, and gofmt on changed Go files: completed. `git diff --check` for changed tracked docs/contracts/device-service files passed.

## Full device-service run: tests not validated

The following are the exact failed/cancelled test or suite names from that run
(deduplicated; test bodies requiring fixtures could not establish their assertions):

- authentication: missing, malformed, expired, wrong-audience and forged tokens are 401
- authorization: viewers read but cannot write; only admins create sites and bins
- tenant isolation over HTTP: tenant B cannot see or change tenant A, and a forged tenant header is ignored
- registration is idempotent over HTTP and requires a valid Idempotency-Key
- optimistic concurrency: ETag, If-Match, 428 and 412
- status changes bump the version and validate input
- pagination: bounded pages with a stable cursor
- malformed requests get problem+json without leaking internals
- correlation: valid IDs are kept and reach the outbox; invalid ones are replaced
- event contracts: every outbox event written through the API validates
- traceparent flags are normalised to the sampled bit so stored events stay valid
- H6: facility commands require valid keys and replay stable responses
- services/device-service/dist/api/api.test.js
- health probes keep their own body when the API is enabled
- without API options only the health routes exist
- a request's server span is the origin trace stored on the outbox event
- header versioning: default version is echoed and a deprecated version announces its sunset
- header versioning: after the sunset instant the old version is 410 Gone, before authentication
- defaults when header absent
- explicit supported version with padding
- deprecated version sets all headers and appends Vary and Link
- deprecated without sunset omits Sunset, Link
- sunset without deprecatedAt is implicitly deprecated
- boundary: now equals deprecatedAt is deprecated, before is current
- boundary: now equals sunsetAt is 410 and one second earlier is 200
- sunset without successor omits successor field
- unsupported versions return 400 with the non-sunset list
- long invalid value is truncated to 64 chars in the body
- database failures change readiness but not liveness; shutdown closes probe
- tenant context ends with its transaction on a reused connection
- a failed transaction does not leave its tenant context behind
- alternating tenants only ever see their own rows
- D03 over direct session
- D03 over PgBouncer
- D02: runtime role cannot bypass RLS and owns no tables
- D02: without a tenant context the runtime role sees no rows
- D02: tenant B cannot read tenant A
- D02: tenant B cannot insert rows for tenant A
- D02: tenant B cannot change tenant A's devices
- D02: tenant B cannot reference tenant A's site or bin
- a device's bin must belong to the device's site
- runtime role cannot delete, rewrite identity, or touch history
- H6: tenant A cannot create or read tenant B facilities or outbox
- services/device-service/dist/inventory/isolation.test.js
- registration writes device, outbox event, audit and receipt together
- a retry with the same idempotency key returns the original result
- concurrent retries of one command create exactly one device
- reusing an idempotency key for a different request is rejected
- a duplicate serial number under a new key is rejected
- other database errors are passed through unchanged
- optimistic: a stale version changes nothing and reports the current one
- optimistic: of two concurrent edits from the same version, exactly one wins
- optimistic: an unknown device is reported as not found
- pessimistic: status change locks the row, bumps the version and emits an event
- pessimistic: a held lock fails fast with NOWAIT and times out otherwise
- receipt, outbox event and audit record share one command ID
- a duplicate bin is reported as a duplicate bin
- device lists are bounded keyset pages
- malformed versions and cursors are rejected as invalid input
- H6: site creation is atomic, traced and idempotent
- H6: site outbox failure rolls back the facility and receipt
- H6: bin creation is atomic, traced and idempotent
- H6: bin outbox failure rolls back the facility and receipt
- services/device-service/dist/inventory/repository.test.js
- startup listens and reports readiness against an unreachable database
- startup mounts the authenticated API when AUTH_* is configured
- startup enables tracing when a collector endpoint is configured
- D01: migrations build an empty database, re-apply cleanly and match the schema
- R1: CDC can snapshot both tenants' outbox rows and nothing else

## Verification limits and follow-up

The new database tests cover facility transaction rollback after outbox failure,
one event/audit/receipt under concurrent retries, and cross-tenant site/bin/outbox
denial; those database assertions remain unverified here. Migration deployment,
upgrade/schema drift, forced RLS and composite FK behavior need the live database
suite. Offline unit fakes do not prove PostgreSQL rollback or RLS.

No Docker, make verify, smoke, events, Sonar or live-stack checks were run, per the
owner's offline-only scope. `coderabbit review --help` was inspected, but the
network-backed CodeRabbit review was not run under that restriction. No CodeRabbit
or Sonar quality-gate pass is claimed.

Infrastructure-owner note for `docs/EVENTS_INFRA.md` (not edited): document the
six-partition `greenguard.inventory.facility.v1` topic, `site.changed`/`bin.changed`
routing, and the ADR-0010 plain JSON/six-header contract. Register the facility
subject `greenguard.inventory.facility.v1-value` as a union of both schemas in the
CI/release gate; Registry provisioning, compatibility execution and live topic
creation were not performed here. Alert projection now belongs to Stage 06.
