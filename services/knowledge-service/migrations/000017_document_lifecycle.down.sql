DROP TABLE knowledge_lifecycle_outbox;
DROP TABLE knowledge_upload_intents;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='knowledge_app') THEN
  REVOKE DELETE ON knowledge_graph_facts FROM knowledge_app;
 END IF;
END $$;
