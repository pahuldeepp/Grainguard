# @greenguard/membership-client

Stage 09a (ADR-0017). Maps a verified `(issuer, subject)` to `(tenant, roles)` through
the tenant-control-plane lookup API, for use with the `mapIdentity` hook of
`@greenguard/tenant-auth` without changing its verification order (token first).

- Positive entries are fresh for 30 s, negative entries for 5 s.
- `membershipChangedHandler` invalidates an entry for a `membership.changed` event.
  Consumers must await the handler before acknowledging the event. Its Redis version
  floor prevents duplicate or reordered events and stale in-flight lookups from
  restoring an older grant across replicas.
- A failed refresh keeps the last good entry until 5 minutes after it was fetched,
  then denies (`401 invalid_claims`); errors never allow access.
- `createVerifierFromEnv` keeps the file source unless
  `AUTH_MEMBERSHIP_SOURCE=control-plane` (then needs `CONTROL_PLANE_URL` and
  `CONTROL_LOOKUP_TOKEN`, plus the existing OIDC issuer/audience/JWKS settings).
  Pass `createRedisMembershipVersionStore(redis)` as its third argument and register
  `verifier.onMembershipChanged` as the broadcast event consumer. The Redis client
  must implement `get` and `eval`, as node-redis clients and clusters do.
