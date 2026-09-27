-- Stage 09g. Connection updates use optimistic versions; domain ownership is
-- globally unique so two tenants cannot enable JIT for the same email domain.
CREATE TABLE identity_connections (
  tenant_id UUID NOT NULL REFERENCES organizations(tenant_id),
  connection_id UUID NOT NULL,
  issuer TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('oidc', 'saml')),
  jit_enabled BOOLEAN NOT NULL DEFAULT false,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, connection_id),
  UNIQUE (tenant_id, issuer),
  CHECK (length(issuer) BETWEEN 1 AND 512)
);
CREATE TABLE identity_connection_domains (
  tenant_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  domain TEXT NOT NULL,
  verified_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, connection_id, domain),
  UNIQUE (domain),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES identity_connections(tenant_id, connection_id) ON DELETE RESTRICT,
  CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$')
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['identity_connections', 'identity_connection_domains'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON identity_connections, identity_connection_domains TO control_app;
GRANT UPDATE (jit_enabled, version, updated_at) ON identity_connections TO control_app;
-- Domains are immutable claims. Disable a connection to stop JIT; no runtime DELETE.

-- Narrow cross-tenant lookup after token verification. The function exposes only
-- a tenant ID for an active, verified issuer/domain pair, never connection rows.
CREATE POLICY jit_connection_read ON identity_connections FOR SELECT TO control_migrator USING (true);
CREATE POLICY jit_domain_read ON identity_connection_domains FOR SELECT TO control_migrator USING (true);
CREATE POLICY jit_organization_read ON organizations FOR SELECT TO control_migrator USING (true);
CREATE FUNCTION find_jit_tenant(p_issuer text, p_domain text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT c.tenant_id FROM identity_connections c
      JOIN identity_connection_domains d
        ON d.tenant_id = c.tenant_id AND d.connection_id = c.connection_id
      JOIN organizations o ON o.tenant_id = c.tenant_id
     WHERE c.issuer = p_issuer AND d.domain = p_domain
       AND c.jit_enabled AND o.state = 'active'
     LIMIT 1;
  $$;
REVOKE ALL ON FUNCTION find_jit_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_jit_tenant(text, text) TO control_app;

CREATE FUNCTION discover_identity_realm(p_domain text)
  RETURNS TABLE(issuer text, type text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT c.issuer, c.type FROM identity_connection_domains d
      JOIN identity_connections c
        ON c.tenant_id = d.tenant_id AND c.connection_id = d.connection_id
      JOIN organizations o ON o.tenant_id = c.tenant_id
     WHERE d.domain = p_domain AND o.state = 'active' LIMIT 1;
  $$;
REVOKE ALL ON FUNCTION discover_identity_realm(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION discover_identity_realm(text) TO control_app;
