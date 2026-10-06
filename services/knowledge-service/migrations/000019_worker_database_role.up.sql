-- Background consumers use a distinct non-owner login from the HTTP API.
-- FORCE RLS remains authoritative: every worker operation must set the same
-- tenant context before accessing rows, and summary/retention also set user_id.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='knowledge_worker') THEN
    RAISE EXCEPTION 'knowledge_worker must be provisioned by the disposable AI role bootstrap';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='knowledge_worker' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'knowledge_worker must not be superuser or bypass RLS';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO knowledge_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON
  knowledge_documents, knowledge_document_versions, knowledge_chunks,
  knowledge_index_outbox, knowledge_index_failures,
  knowledge_document_outlines, knowledge_outline_nodes, knowledge_outline_chunks,
  knowledge_graph_entities, knowledge_graph_facts,
  knowledge_lifecycle_outbox, knowledge_upload_intents,
  assistant_suggestion_usage_outbox, assistant_suggestion_usage_events,
  assistant_suggestion_usage_daily, assistant_summary_jobs
TO knowledge_worker;
GRANT DELETE ON assistant_conversations TO knowledge_worker;
GRANT EXECUTE ON FUNCTION knowledge_summary_pending_principals(uuid) TO knowledge_worker;

REVOKE ALL ON knowledge_auth_memberships, knowledge_membership_audit FROM knowledge_worker;
REVOKE CREATE ON SCHEMA public FROM knowledge_worker;
