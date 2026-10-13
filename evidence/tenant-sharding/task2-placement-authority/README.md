# Task 2: placement authority evidence

## Scope delivered

- Registry data seeds stable `s1`–`s4` IDs; the API permits future registered IDs.
- Persisted organization placement and signed PostgreSQL BIGINT epochs serialized as decimal strings.
- SHA-256 ring with 128 virtual positions suggests onboarding placement only; immutable ring history and the chosen shard are persisted atomically.
- Runtime reads use persisted placement and registry incarnation. Public onboarding and placement endpoints reject caller routing hints.
- Authenticated private lookup plus membership-checked user lookup; existing identity and membership regression tests pass.
- One-second authority leases, bounded resolver cache, in-flight invalidation, expired-route outage rejection, expected-epoch checks, and HTTPS/mTLS transport configuration.
- Durable move ledger with one live move per tenant, organization-first locks, `preparing` bulk-copy phase before `quiescing`, immutable positive receipt markers, atomic ledger-first ownership CAS, idempotency, activation, and fenced abort.
- Forced RLS, restricted runtime grants, database epoch/transition constraints, and offline incarnation rotation guard.

## Executed proof

All PostgreSQL runs used a new, task-owned loopback Docker container with random credentials. Shared development or production state was not used.

| Gate | Result |
| --- | --- |
| Tenant control-plane and dependency TypeScript builds | Pass |
| Actual Prisma migration deploy, legacy startup | All 20 migrations pass |
| Control-plane domain/API/migration/old membership regressions | 39 passed, 0 failed |
| Membership-client entire package | 31 passed, 0 failed, 1 optional Kafka/Redis integration skipped |
| Control placement domain/controller coverage | 99.12% lines, 84.61% branches, 100% functions |
| Client placement/ring coverage | 98.95% lines, 96.72% branches, 100% functions |
| Focused ESLint, Prettier, diff whitespace checks | Pass |
| Actual Prisma greenfield startup proof | All 20 migrations pass; first ring contains all four; all four registry entries start offline |
| Greenfield onboarding admission | Rejected until operator fixture activation; 40 new fixture tenants persisted across all four after activation |

Greenfield proof used PostgreSQL connection startup `options=-c greenguard.bootstrap_mode=greenfield`. Activation in this test changes metadata as an isolated fixture; it does not prove four operational primaries/replicas, CDC, or AWS readiness. Legacy upgrades retain `s1` active, `s2`–`s4` offline, ring v1 containing only `s1`; later proven activation publishes a new immutable ring and changes policy atomically.

## CodeRabbit review

Both final scoped reviews completed successfully. The control-plane review returned one minor finding to constrain abort transitions to active/quiescing state without a shard change; the client review returned one minor finding to cancel non-200 HTTP response bodies. Both were fixed and final SQL migration, focused regressions, and client coverage rerun successfully. Review logs are retained here.

Earlier valid review findings were also addressed: JSONB receipt equality only on replay, positive `verified: true` receipt markers, durable runtime transition constraints, switched ledger before organization CAS, path-prefix preservation, expected epoch ahead of cache triggering authoritative refresh, bounded route-lifetime regression guards, and initial ring members excluded until ready. Two earlier review claims of duplicated TypeScript functions were rejected after inspecting actual source and passing builds/tests; those claims did not match current source. Recoverable review disconnects were retried; the final two runs completed.

## Integration contracts remaining

- Bootstrap must initialize each operational owner with the registry's exact `shard_incarnation` UUID and activate targets only after primary/replica, migrations, ownership import, and connector readiness. Registry metadata does not prove readiness by itself.
- Control-plane authority must use its primary; runtime transactions must enforce the database-local `{tenant, shard, incarnation, epoch}` ownership tuple. The process cache is a temporary diagnostic guard, not durable fencing, and expiry/eviction/restart requires authoritative lookup.
- APIs, background workers, projections, outboxes and read leases must adopt this resolver. Redis read/population fences must compare against persisted placement and incarnation.
- The trusted migration controller must verify actual source-fence, target-preparation, copy-verification and activation receipts and bind receipt contents to operation/source/target/epoch/incarnation before storage. This slice supplies the ledger/interface and requires positive markers; it does not implement operational database receipt verification, data copy, pause/drain or activation.
- No public migration endpoint is exposed. Event-driven placement invalidation and full platform/AWS/physical-iPhone acceptance remain later integration work.

No commit or real AWS apply was performed in this slice. The parent integrates these files with the operational ownership and infrastructure work, reviews the combined result, and commits scoped evidence after the combined gate.
