-- First-party authorization; provision/revoke through a separate control-plane role.
-- The runtime role is read-only and cannot grant itself membership.
CREATE TABLE knowledge_auth_memberships (
    tenant_id uuid NOT NULL,
    issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
    subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
    principal_id uuid NOT NULL,
    roles text[] NOT NULL CHECK (cardinality(roles) BETWEEN 1 AND 3
        AND roles <@ ARRAY['viewer','operator','admin']::text[]
        AND array_position(roles,NULL) IS NULL),
    active boolean NOT NULL DEFAULT false,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,issuer,subject),
    UNIQUE (tenant_id,principal_id)
);
ALTER TABLE knowledge_auth_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_auth_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_auth_memberships
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON knowledge_auth_memberships FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='knowledge_app') THEN
  REVOKE ALL ON knowledge_auth_memberships FROM knowledge_app;
  GRANT SELECT ON knowledge_auth_memberships TO knowledge_app;
 END IF;
END $$;
-- Membership changes use optimistic revision checks: UPDATE ... WHERE revision=<expected>.
-- Membership mutation/API provisioning is intentionally not granted to the RAG workload.
