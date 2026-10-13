-- Recovery state is durable; the outbox row lock serializes failure updates.
ALTER TABLE knowledge_index_outbox ADD CONSTRAINT knowledge_index_outbox_tenant_event_uq UNIQUE (tenant_id,event_id);
CREATE TABLE knowledge_index_failures (
 tenant_id uuid NOT NULL,
 event_id uuid NOT NULL,
 attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
 reason text NOT NULL CHECK (reason IN ('invalid_pdf','index_unavailable')),
 quarantined_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (tenant_id,event_id),
 FOREIGN KEY (tenant_id,event_id) REFERENCES knowledge_index_outbox(tenant_id,event_id) ON DELETE CASCADE
);
ALTER TABLE knowledge_index_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_index_failures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_index_failures
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='knowledge_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON knowledge_index_failures TO knowledge_app;
 END IF;
END $$;
