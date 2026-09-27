# ADR-0018: Machine authentication

Status: Accepted for Stage 09b (2026-09-25)

## Decision

API keys are 256-bit random secrets, formatted `gg_<env>_<usr|dev>_<public UUID>_<base64url secret>`. The control plane stores only `HMAC-SHA-256(server pepper, secret)` and uses `timingSafeEqual` after a public-ID lookup. The pepper is supplied by the secret store (`CONTROL_API_KEY_PEPPER`), never by the caller. It is required to enable the key routes. A compromised credential table alone does not reveal the key. Key plaintext is returned at issuance or rotation only; receipts, metadata listings, outbox events, and logs omit it.

Every key and OAuth client belongs to a service principal with exactly one tenant. Tenant-scoped transactions use forced RLS and explicit `tenant_id` predicates. Public key IDs and issuer/client pairs resolve to one tenant through narrowly granted security-definer functions; caller-supplied `tenant_id` is ignored. A unique issuer/client index prevents ambiguous mappings. Creator membership and organization state are checked on each verification. Revocation has no positive credential cache in the control-plane verifier. Rotation locks the old key row and creates one successor, with configurable overlap (0–168 hours; default 24). The key limit is checked atomically with device and tenant buckets before ingest spends a token.

Enterprise integrations should use OAuth 2.0 client credentials. The configured issuer/JWKS verifier requires RS256, matching issuer and audience, `exp`, `iat`, `sub`, a client-credentials grant marker, a token lifetime at most 15 minutes by default, and scopes no broader than the first-party service principal. The token's tenant claim is never used. Both mechanisms yield `{tenant_id, principal_id, principal_type: "service", scopes}`. API-key context may also carry `key_id` and `device_id` for enforcement.

## Consequences

Ingest calls the control plane for every API key or OAuth M2M request. An outage fails closed with 503, and revoked keys stop working on the next lookup. This deliberately trades a network hop for immediate revocation rather than implementing a second credential cache/feed in Stage 09b. The existing device-binding feed still decides whether the verified device may ingest. Local rate buckets remain process-local as in ADR-0007; a distributed per-key limit is needed before horizontally scaled production traffic.
