-- Run as a migration owner; never as the model gateway runtime role.
-- Money/quota updates use explicit pessimistic row locks, tenant then user.
-- Global product cap is explicitly non-tenant; only narrowly scoped runtime
-- counter updates are granted. Lock platform first, then tenant, then user.
CREATE TABLE ai_platform_budget (
 period date PRIMARY KEY,limit_micros bigint NOT NULL CHECK(limit_micros>=0),limit_tokens bigint NOT NULL CHECK(limit_tokens>=0),
 held_micros bigint NOT NULL DEFAULT 0 CHECK(held_micros>=0),spent_micros bigint NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
 held_tokens bigint NOT NULL DEFAULT 0 CHECK(held_tokens>=0),spent_tokens bigint NOT NULL DEFAULT 0 CHECK(spent_tokens>=0),version bigint NOT NULL DEFAULT 1,
 CHECK(held_micros+spent_micros<=limit_micros),CHECK(held_tokens+spent_tokens<=limit_tokens)
);
CREATE TABLE ai_budget_accounts (
 tenant_id uuid NOT NULL, scope text NOT NULL, period date NOT NULL,
 limit_micros bigint NOT NULL CHECK(limit_micros>=0), limit_tokens bigint NOT NULL CHECK(limit_tokens>=0),
 held_micros bigint NOT NULL DEFAULT 0 CHECK(held_micros>=0), spent_micros bigint NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
 held_tokens bigint NOT NULL DEFAULT 0 CHECK(held_tokens>=0), spent_tokens bigint NOT NULL DEFAULT 0 CHECK(spent_tokens>=0), version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,scope,period), CHECK(held_micros+spent_micros<=limit_micros),CHECK(held_tokens+spent_tokens<=limit_tokens)
);
CREATE TABLE ai_budget_attempts (
 tenant_id uuid NOT NULL,id text NOT NULL, principal_id text NOT NULL,model text NOT NULL,provider text NOT NULL,period date NOT NULL,
 reserved_micros bigint NOT NULL CHECK(reserved_micros>=0),reserved_tokens bigint NOT NULL CHECK(reserved_tokens>=0),
 state text NOT NULL DEFAULT 'held' CHECK(state IN ('held','settled')),
 spent_micros bigint CHECK(spent_micros>=0),spent_tokens bigint CHECK(spent_tokens>=0),usage_known boolean,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,settled_at timestamptz,
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE ai_usage_outbox (
 tenant_id uuid NOT NULL,id text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,id) REFERENCES ai_budget_attempts(tenant_id,id)
);
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['ai_budget_accounts','ai_budget_attempts','ai_usage_outbox'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 END LOOP;
END $$;
-- Provision a NOSUPERUSER NOBYPASSRLS role named model_gateway_app beforehand.
GRANT SELECT ON ai_budget_accounts,ai_budget_attempts TO model_gateway_app;
GRANT UPDATE(held_micros,spent_micros,held_tokens,spent_tokens,version) ON ai_budget_accounts TO model_gateway_app;
GRANT INSERT ON ai_budget_attempts,ai_usage_outbox TO model_gateway_app;
GRANT UPDATE(state,spent_tokens,spent_micros,usage_known,settled_at) ON ai_budget_attempts TO model_gateway_app;

GRANT SELECT ON ai_platform_budget TO model_gateway_app;
GRANT UPDATE(held_micros,spent_micros,held_tokens,spent_tokens,version) ON ai_platform_budget TO model_gateway_app;

CREATE INDEX ai_budget_held_reaper ON ai_budget_attempts(tenant_id,created_at) WHERE state='held';
