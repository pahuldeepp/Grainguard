-- PostgreSQL is the cache invalidation authority. Revision changes commit/roll
-- back with document, projection, ACL and membership mutations.
CREATE TABLE knowledge_cache_revisions (
 tenant_id uuid PRIMARY KEY,
 revision bigint NOT NULL CHECK (revision > 0)
);
ALTER TABLE knowledge_cache_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_cache_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_cache_revisions
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON knowledge_cache_revisions FROM PUBLIC;
INSERT INTO knowledge_cache_revisions(tenant_id,revision)
 SELECT tenant_id,1 FROM knowledge_documents
 UNION SELECT tenant_id,1 FROM knowledge_auth_memberships;

-- Owned by the migration role. Runtime cannot alter revisions directly. Fixed
-- search_path and qualified writes prevent caller-controlled object resolution.
-- Forced RLS still protects non-BYPASSRLS function owners; privileged migration
-- owners support provisioning jobs that intentionally omit app.tenant_id.
CREATE FUNCTION knowledge_bump_cache_revision() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE changed uuid; selected_tenant uuid;
BEGIN
 selected_tenant := NULLIF(current_setting('app.tenant_id',true),'')::uuid;
 FOR changed IN
  SELECT DISTINCT tenant_id FROM new_rows ORDER BY tenant_id
 LOOP
  IF selected_tenant IS NOT NULL AND changed <> selected_tenant THEN
   RAISE EXCEPTION 'cache revision tenant mismatch' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.knowledge_cache_revisions(tenant_id,revision) VALUES(changed,1)
   ON CONFLICT(tenant_id) DO UPDATE SET revision=knowledge_cache_revisions.revision+1;
 END LOOP;
 RETURN NULL;
END $$;
-- Separate transition functions avoid referencing transition relations absent
-- for INSERT/DELETE and preserve both tenants if an administrator moves a row.
CREATE FUNCTION knowledge_bump_cache_revision_old() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE changed uuid; selected_tenant uuid;
BEGIN
 selected_tenant := NULLIF(current_setting('app.tenant_id',true),'')::uuid;
 FOR changed IN SELECT DISTINCT tenant_id FROM old_rows ORDER BY tenant_id LOOP
  IF selected_tenant IS NOT NULL AND changed <> selected_tenant THEN
   RAISE EXCEPTION 'cache revision tenant mismatch' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.knowledge_cache_revisions(tenant_id,revision) VALUES(changed,1)
   ON CONFLICT(tenant_id) DO UPDATE SET revision=knowledge_cache_revisions.revision+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE FUNCTION knowledge_bump_cache_revision_update() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE changed uuid; selected_tenant uuid;
BEGIN
 selected_tenant := NULLIF(current_setting('app.tenant_id',true),'')::uuid;
 FOR changed IN SELECT tenant_id FROM new_rows UNION SELECT tenant_id FROM old_rows ORDER BY tenant_id LOOP
  IF selected_tenant IS NOT NULL AND changed <> selected_tenant THEN
   RAISE EXCEPTION 'cache revision tenant mismatch' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.knowledge_cache_revisions(tenant_id,revision) VALUES(changed,1)
   ON CONFLICT(tenant_id) DO UPDATE SET revision=knowledge_cache_revisions.revision+1;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION knowledge_bump_cache_revision(),knowledge_bump_cache_revision_old(),knowledge_bump_cache_revision_update() FROM PUBLIC;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['knowledge_documents','knowledge_document_versions','knowledge_chunks','knowledge_outline_nodes','knowledge_outline_chunks','knowledge_document_outlines','knowledge_graph_entities','knowledge_graph_facts','knowledge_auth_memberships'] LOOP
  EXECUTE format('CREATE TRIGGER cache_revision_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION knowledge_bump_cache_revision()',name);
  EXECUTE format('CREATE TRIGGER cache_revision_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION knowledge_bump_cache_revision_old()',name);
  EXECUTE format('CREATE TRIGGER cache_revision_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION knowledge_bump_cache_revision_update()',name);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='knowledge_app') THEN
  GRANT SELECT ON knowledge_cache_revisions TO knowledge_app;
 END IF;
END $$;
