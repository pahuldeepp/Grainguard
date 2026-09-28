-- Stage 09 review fix (ADR-0020). OAuth client ids are not secret, so "first tenant
-- to register an (issuer, client_id) wins" let tenant B capture tenant A's machine
-- tokens. The binding is now per tenant: the IdP mints a tenant claim into the
-- client's token, the verifier passes that claim as the tenant hint, and a client
-- resolves only inside the tenant that registered it (forced RLS, no cross-tenant
-- resolver). Concurrency: registration still locks the organization row first.
DROP FUNCTION IF EXISTS resolve_oauth_client(text, text);
DROP INDEX IF EXISTS service_principal_oauth_unique;
CREATE UNIQUE INDEX service_principal_oauth_unique
  ON service_principals (tenant_id, issuer, client_id) WHERE kind = 'oauth_client';
