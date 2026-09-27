-- Stage 09b. Every credential belongs to exactly one organization. Contended
-- issuance/rotation locks that organization first; updates use a version check.
CREATE TABLE service_principals (
  tenant_id uuid NOT NULL REFERENCES organizations(tenant_id),
  principal_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('api_key','oauth_client')),
  issuer text,
  client_id text,
  allowed_scopes text[] NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, principal_id),
  CONSTRAINT service_principal_oauth_identity CHECK ((kind = 'oauth_client') = (issuer IS NOT NULL AND client_id IS NOT NULL)),
  CONSTRAINT service_principal_scopes CHECK (cardinality(allowed_scopes) BETWEEN 1 AND 32)
);
-- A single verified issuer/client pair can never resolve to two tenants.
CREATE UNIQUE INDEX service_principal_oauth_unique ON service_principals (issuer, client_id) WHERE kind = 'oauth_client';

CREATE TABLE api_keys (
  tenant_id uuid NOT NULL,
  key_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('usr','dev')),
  device_id uuid,
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  scopes text[] NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  rotated_to uuid,
  last_used_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, key_id),
  UNIQUE (key_id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES service_principals(tenant_id, principal_id),
  CONSTRAINT api_key_device_kind CHECK ((kind = 'dev') = (device_id IS NOT NULL)),
  CONSTRAINT api_key_scope_count CHECK (cardinality(scopes) BETWEEN 1 AND 32)
);
CREATE INDEX api_key_principal_active ON api_keys (tenant_id, principal_id) WHERE revoked_at IS NULL;

ALTER TABLE service_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_principals FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON service_principals
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Credential verification uses a separate, narrowly granted role. No tenant is
-- supplied by the caller: a SECURITY DEFINER function resolves public key ID or
-- verified issuer/client pair to one tenant before a scoped transaction begins.
CREATE OR REPLACE FUNCTION resolve_api_key(p_key_id uuid)
RETURNS TABLE(tenant_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT k.tenant_id FROM api_keys k WHERE k.key_id = p_key_id
$$;
CREATE OR REPLACE FUNCTION resolve_oauth_client(p_issuer text, p_client_id text)
RETURNS TABLE(tenant_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.tenant_id FROM service_principals s
   WHERE s.issuer = p_issuer AND s.client_id = p_client_id AND s.kind = 'oauth_client'
$$;
REVOKE ALL ON FUNCTION resolve_api_key(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_oauth_client(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(uuid), resolve_oauth_client(text,text) TO control_app;
GRANT SELECT, INSERT ON service_principals, api_keys TO control_app;
GRANT UPDATE (state, revoked_at, version) ON service_principals TO control_app;
GRANT UPDATE (expires_at, revoked_at, rotated_to, last_used_at, version) ON api_keys TO control_app;
