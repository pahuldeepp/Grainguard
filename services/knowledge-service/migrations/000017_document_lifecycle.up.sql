-- Parent row locks serialize index publication, delete, retention and reindex.
-- Jobs retain immutable IDs/keys after source rows are removed; retries are idempotent.
CREATE TABLE knowledge_lifecycle_outbox (
 tenant_id uuid NOT NULL,
 event_id uuid NOT NULL,
 document_id uuid NOT NULL,
 document_version bigint NOT NULL CHECK (document_version > 0),
 operation text NOT NULL CHECK (operation IN ('vectors','source')),
 chunk_ids uuid[] NOT NULL DEFAULT '{}',
 source_object_key text,
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (tenant_id,event_id),
 UNIQUE (tenant_id,document_id,document_version,operation),
 FOREIGN KEY (tenant_id,document_id) REFERENCES knowledge_documents(tenant_id,document_id)
);
CREATE INDEX knowledge_lifecycle_pending_idx ON knowledge_lifecycle_outbox(tenant_id,available_at,event_id) WHERE completed_at IS NULL;
ALTER TABLE knowledge_lifecycle_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_lifecycle_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_lifecycle_outbox
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='knowledge_app') THEN
  GRANT SELECT,INSERT,UPDATE ON knowledge_lifecycle_outbox TO knowledge_app;
 END IF;
END $$;

-- Upload reservation commits before the object provider is contacted. A crash
-- leaves a known immutable key for reconciliation, without a document FK.
CREATE TABLE knowledge_upload_intents (
 tenant_id uuid NOT NULL,
 intent_id uuid NOT NULL,
 source_object_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 PRIMARY KEY (tenant_id,intent_id),
 UNIQUE (tenant_id,source_object_key)
);
ALTER TABLE knowledge_upload_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_upload_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_upload_intents
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='knowledge_app') THEN
  GRANT SELECT,INSERT,UPDATE ON knowledge_upload_intents TO knowledge_app;
  GRANT DELETE ON knowledge_graph_facts TO knowledge_app;
 END IF;
END $$;
