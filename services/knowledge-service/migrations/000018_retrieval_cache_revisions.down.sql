DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['knowledge_documents','knowledge_document_versions','knowledge_chunks','knowledge_outline_nodes','knowledge_outline_chunks','knowledge_document_outlines','knowledge_graph_entities','knowledge_graph_facts','knowledge_auth_memberships'] LOOP
  EXECUTE format('DROP TRIGGER cache_revision_insert ON %I',name);
  EXECUTE format('DROP TRIGGER cache_revision_delete ON %I',name);
  EXECUTE format('DROP TRIGGER cache_revision_update ON %I',name);
 END LOOP;
END $$;
DROP FUNCTION knowledge_bump_cache_revision(),knowledge_bump_cache_revision_old(),knowledge_bump_cache_revision_update();
DROP TABLE knowledge_cache_revisions;
