-- Additive migration, owner only. Provision model_gateway_usage_app separately
-- as NOSUPERUSER NOBYPASSRLS; never grant this role to HTTP gateway callers.
ALTER TABLE ai_usage_outbox
 ADD COLUMN claim_token uuid,
 ADD COLUMN claimed_until timestamptz,
 ADD COLUMN published_at timestamptz,
 ADD CONSTRAINT usage_claim_pair CHECK((claim_token IS NULL)=(claimed_until IS NULL));
CREATE INDEX ai_usage_pending ON ai_usage_outbox(tenant_id,created_at,id) WHERE published_at IS NULL;
CREATE TABLE ai_usage_events (
 tenant_id uuid NOT NULL,attempt_id text NOT NULL,principal_id text NOT NULL,
 occurred_at timestamptz NOT NULL,period date NOT NULL,model text NOT NULL,provider text NOT NULL,
 tokens bigint NOT NULL CHECK(tokens>=0),micros bigint NOT NULL CHECK(micros>=0),usage_known boolean NOT NULL,
 PRIMARY KEY(tenant_id,attempt_id),FOREIGN KEY(tenant_id,attempt_id) REFERENCES ai_usage_outbox(tenant_id,id)
);
CREATE TABLE ai_usage_daily (
 tenant_id uuid NOT NULL,principal_id text NOT NULL,usage_date date NOT NULL,
 model text NOT NULL,provider text NOT NULL,
 attempts bigint NOT NULL CHECK(attempts>=0),tokens bigint NOT NULL CHECK(tokens>=0),micros bigint NOT NULL CHECK(micros>=0),
 unknown_attempts bigint NOT NULL CHECK(unknown_attempts>=0 AND unknown_attempts<=attempts),
 PRIMARY KEY(tenant_id,principal_id,usage_date,model,provider)
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['ai_usage_events','ai_usage_daily'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY usage_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid AND principal_id=coalesce(current_setting(''app.principal_id'',true),'''')) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid AND principal_id=coalesce(current_setting(''app.principal_id'',true),''''))',tab);
 END LOOP;
END $$;
REVOKE ALL ON ai_usage_events,ai_usage_daily FROM PUBLIC;
GRANT SELECT ON ai_budget_attempts,ai_usage_outbox TO model_gateway_usage_app;
GRANT UPDATE(claim_token,claimed_until,published_at) ON ai_usage_outbox TO model_gateway_usage_app;
GRANT SELECT,INSERT ON ai_usage_events TO model_gateway_usage_app;
GRANT SELECT,INSERT,UPDATE ON ai_usage_daily TO model_gateway_usage_app;
