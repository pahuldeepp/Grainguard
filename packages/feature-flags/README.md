# Feature flags

Stage 09f OpenFeature server provider. Applications define typed defaults in code and call `createFlagEvaluator`. The caller must pass `contextFromVerifiedPrincipal(principal)` using the principal returned by the authentication verifier. Request headers, body, path, query and IdP tenant claims are not valid sources for this context. The package does not perform authentication or choose a tenant.

```ts
const defaults = { "optional-notifications": false, "scoring-v2": false } as const;
const store = new VersionedFlagStore(30_000, Date.now, scope => alertOnStale(scope));
const flags = createFlagEvaluator(defaults, store);
const decision = await flags.evaluate("scoring-v2", contextFromVerifiedPrincipal(principal));
// Persist decision.configVersion alongside billing/scoring results when present.
```

`VersionedFlagStore.apply` accepts full versioned snapshots from a trusted control-plane event consumer. Duplicate or older versions do not replace a newer snapshot. `refresh` is for a successful authoritative snapshot fetch and can renew freshness at the same version. A stale snapshot, provider outage, missing flag, or wrong value type returns the typed code default. A stale callback is provided for alerting. Fresh last-good data remains usable after a failed fetch until the configured freshness bound. Rollout uses a stable SHA-256 bucket of flag key and verified tenant ID, so one tenant receives a consistent result across instances. A boolean kill switch can disable optional work, but call sites must preserve queued work and must never put authorization, receipts or outbox guarantees behind a flag.

The `flag.configuration_changed` contract is a full scope snapshot. The control plane must commit configuration, audit and outbox atomically and serve a versioned snapshot endpoint for bootstrap and reconciliation. It must also enforce tenant RLS and application filters. The package owns only the local evaluation cache; the control plane remains the sole configuration writer and tenant authority. DynamoDB is Stage 10.

Run `npm test --prefix packages/feature-flags` and `npm run coverage --prefix packages/feature-flags` from the repository root.
