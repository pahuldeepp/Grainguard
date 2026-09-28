-- Stage 09g hardening (review request #3). A verified email domain is a lease, not
-- a permanent claim: it carries verified_until and must be re-verified (DNS TXT).
-- Claims are never deleted (no DELETE grant): status 'released' frees the domain.
-- Forward-only (review O5); no applied migration is edited.
ALTER TABLE identity_connection_domains
  ADD COLUMN verified_until TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp() + interval '30 days',
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  ADD COLUMN released_at TIMESTAMPTZ(6);

-- One live claim per domain. An expired or released claim must not block a new owner.
ALTER TABLE identity_connection_domains DROP CONSTRAINT identity_connection_domains_domain_key;
CREATE UNIQUE INDEX identity_domain_active_claim ON identity_connection_domains (domain) WHERE status = 'active';

GRANT UPDATE (status, verified_until, verified_at, released_at) ON identity_connection_domains TO control_app;

-- Lets the definer function below retire an expired claim owned by another tenant.
CREATE POLICY jit_domain_release ON identity_connection_domains FOR UPDATE TO control_migrator
  USING (true) WITH CHECK (true);
GRANT UPDATE (status, released_at) ON identity_connection_domains TO control_migrator;

-- Retires only claims that already lapsed, and never the caller's own tenant.
CREATE FUNCTION release_expired_domain(p_domain text, p_tenant uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE identity_connection_domains
       SET status = 'released', released_at = clock_timestamp()
     WHERE domain = p_domain AND status = 'active' AND verified_until <= clock_timestamp()
       AND tenant_id <> p_tenant;
  $$;
REVOKE ALL ON FUNCTION release_expired_domain(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_expired_domain(text, uuid) TO control_app;

CREATE OR REPLACE FUNCTION find_jit_tenant(p_issuer text, p_domain text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT c.tenant_id FROM identity_connections c
      JOIN identity_connection_domains d
        ON d.tenant_id = c.tenant_id AND d.connection_id = c.connection_id
      JOIN organizations o ON o.tenant_id = c.tenant_id
     WHERE c.issuer = p_issuer AND d.domain = p_domain
       AND d.status = 'active' AND d.verified_until > clock_timestamp()
       AND c.jit_enabled AND o.state = 'active'
     LIMIT 1;
  $$;

CREATE OR REPLACE FUNCTION discover_identity_realm(p_domain text)
  RETURNS TABLE(issuer text, type text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT c.issuer, c.type FROM identity_connection_domains d
      JOIN identity_connections c
        ON c.tenant_id = d.tenant_id AND c.connection_id = d.connection_id
      JOIN organizations o ON o.tenant_id = c.tenant_id
     WHERE d.domain = p_domain AND d.status = 'active' AND d.verified_until > clock_timestamp()
       AND o.state = 'active' LIMIT 1;
  $$;
