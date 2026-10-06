-- Advisor owns these tables in greenguard_advisor; never the Knowledge DB.
CREATE TABLE action_proposals (
 tenant_id uuid NOT NULL, proposal_id uuid NOT NULL, run_id uuid NOT NULL,
 user_id uuid NOT NULL, action_hash text NOT NULL CHECK(length(action_hash)=64),
 action jsonb NOT NULL, status text NOT NULL CHECK(status IN ('pending','approved','rejected','expired')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), expires_at timestamptz NOT NULL,
 approver_id uuid, approver_role text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,proposal_id)
);
CREATE TABLE advisor_security_audit (
 tenant_id uuid NOT NULL,event_id uuid NOT NULL,user_id uuid NOT NULL,
 proposal_id uuid,kind text NOT NULL CHECK(kind IN ('proposed','approved','rejected','expired','tool_allowed','tool_denied')),
 tool text NOT NULL CHECK(tool IN ('search_knowledge','propose_acknowledge_alert','unknown')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,event_id)
);
CREATE TABLE advisor_security_outbox (
 tenant_id uuid NOT NULL,event_id uuid NOT NULL,payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,event_id),
 FOREIGN KEY(tenant_id,event_id) REFERENCES advisor_security_audit(tenant_id,event_id)
);
CREATE TABLE advisor_decision_receipts (
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,request_id uuid NOT NULL,
 request_hash text NOT NULL,proposal_id uuid NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(tenant_id,user_id,request_id),
 FOREIGN KEY(tenant_id,proposal_id) REFERENCES action_proposals(tenant_id,proposal_id)
);
ALTER TABLE action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY proposal_isolation ON action_proposals
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid AND
 (user_id=NULLIF(current_setting('app.user_id',true),'')::uuid OR current_setting('app.role',true) IN ('operator','admin')))
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid AND
 (user_id=NULLIF(current_setting('app.user_id',true),'')::uuid OR current_setting('app.role',true) IN ('operator','admin')));
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['advisor_security_audit','advisor_security_outbox','advisor_decision_receipts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
REVOKE ALL ON action_proposals,advisor_security_audit,advisor_security_outbox,advisor_decision_receipts FROM PUBLIC;
GRANT SELECT,INSERT ON action_proposals TO advisor_app;
GRANT UPDATE(status,version,approver_id,approver_role) ON action_proposals TO advisor_app;
GRANT SELECT,INSERT ON advisor_security_audit,advisor_security_outbox,advisor_decision_receipts TO advisor_app;
-- Decisions use optimistic version comparison; no provider call holds a lock.
-- Runtime cannot UPDATE/DELETE append-only audit, outbox or receipts.
