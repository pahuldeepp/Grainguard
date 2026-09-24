# packages/tenant-auth

Status: **implemented (Stage 02b)** for Node/TypeScript. The Go tenant-transaction helper is `services/telemetry-ingest/tenant.go`; Python helpers remain planned.

Stages: 02.

Technology: Go/Node/Python helpers.

Responsibility: Claim normalization, tenant boundaries and service/device identity.

Use: `createTokenVerifier({issuer, audience, keys})` verifies RS256 tokens (cached JWKS) and returns a `Principal {subject, tenantId, roles, expiresAt}`; `requireRole` enforces roles. `@greenguard/tenant-auth/testing` provides a signing issuer and JWKS server for tests. Only RS256 is accepted; the tenant comes only from the signed `tenant_id` claim.

Implement the linked requirements in the main coverage matrix and backlog. Completion requires runtime wiring, meaningful tests, relevant failure/tenant isolation evidence, and reproducible local/CI commands. Existing source reference archives live outside this fresh project.
