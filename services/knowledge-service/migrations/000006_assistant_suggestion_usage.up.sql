-- Content-free, tenant-scoped usage event/outbox. The CDC connector can read
-- this append-only table; no prompt, answer, or user/principal identifier is stored.
CREATE TABLE assistant_suggestion_usage_outbox (
    tenant_id uuid NOT NULL,
    event_id uuid NOT NULL,
    suggestion_id text NOT NULL CHECK (suggestion_id IN
        ('grain_moisture','storage_checks','mold_risk','grain_drying','document_summary')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,event_id)
);
CREATE INDEX assistant_suggestion_usage_created_idx
    ON assistant_suggestion_usage_outbox (created_at,tenant_id,event_id);

ALTER TABLE assistant_suggestion_usage_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_suggestion_usage_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assistant_suggestion_usage_outbox
    USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON assistant_suggestion_usage_outbox FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='knowledge_app') THEN
  GRANT SELECT,INSERT ON assistant_suggestion_usage_outbox TO knowledge_app;
 END IF;
END $$;
