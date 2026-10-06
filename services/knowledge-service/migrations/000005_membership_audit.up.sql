-- Provisioning uses revision comparison within a transaction; audit is atomic.
CREATE TABLE knowledge_membership_audit (
 tenant_id uuid NOT NULL,
 event_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 issuer text NOT NULL,
 subject text NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),
 active boolean NOT NULL,
 roles text[] NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 256),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,event_id),
 UNIQUE(tenant_id,issuer,subject,revision)
);
ALTER TABLE knowledge_membership_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_membership_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_membership_audit
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON knowledge_membership_audit FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='knowledge_provisioner') THEN
  GRANT SELECT,INSERT,UPDATE ON knowledge_auth_memberships TO knowledge_provisioner;
  GRANT SELECT,INSERT ON knowledge_membership_audit TO knowledge_provisioner;
 END IF;
END $$;
