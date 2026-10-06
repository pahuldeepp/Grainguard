# ADR-0020: Machine client tenant binding, issuer allow-list and credential replay

Status: Accepted for the Stage 09 review fixes (2026-09-25). Amends ADR-0018.

## Problem

OAuth client ids are not secret and `(issuer, client_id)` was globally unique, first
registrant wins. Tenant B could register tenant A's client id and A's machine tokens
then resolved to B, so A's telemetry would be ingested into B.

## Decision

1. **Issuer allow-list.** `registerOAuthClient` accepts only issuers in the operator
   list (`MACHINE_ISSUER_ALLOWLIST`, comma separated `https://` issuers; default the
   configured `CONTROL_M2M_ISSUER`). An empty list rejects every registration (fail closed).
2. **Per-tenant binding through a signed tenant claim.** The IdP mints a tenant claim
   (`CONTROL_M2M_TENANT_CLAIM`, default `gg_tenant`) into each client's tokens; a tenant
   admin cannot set it. The verifier (`createClientCredentialsVerifier({ tenantClaim })`,
   optional and additive) requires it to be a UUID, passes it to the lookup as the tenant
   hint, and rejects a binding for any other tenant. A token without the claim, or with
   another tenant's, resolves to nothing (401).
3. **Uniqueness is now `(tenant_id, issuer, client_id)`.** The cross-tenant
   `resolve_oauth_client` SECURITY DEFINER function is dropped; lookup runs inside the
   hinted tenant under forced RLS. Squatting a client id captures nothing and cannot
   block the real owner from registering.
4. **Scopes never outrank the creator.** API-key and OAuth verification intersect the
   credential's scopes with the creator's current role scopes; an empty result fails.
5. **Idempotent credential commands.** Create, rotate, revoke store a safe response in the
   receipt in the same transaction as the effect. An identical replay returns that
   response; a secret is never re-revealed (`secretAlreadyRevealed: true`, key id and
   prefix only). A different body under the same key stays a conflict.
   Recovery when the response with the secret was lost: revoke the orphan principal and
   create a new key (the free plan's `api_keys.max = 1` needs the revoke first).
6. Missing organization and non-member both answer 403.

## Operator action

The IdP must add the tenant claim to each client's token, set to the tenant UUID that
registered the client. Tokens without it are refused.
