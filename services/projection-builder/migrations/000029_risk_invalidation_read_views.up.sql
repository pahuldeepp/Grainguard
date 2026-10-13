-- Upgrade existing replay schemas as well as the active public projection.
SET LOCAL lock_timeout='2s';
DO $$ DECLARE s text; active_schema text; BEGIN
 FOR s IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^read_v[1-9][0-9]{0,8}$'
   AND to_regclass(format('%I.risk_assessment_invalidations',nspname)) IS NULL LOOP
  EXECUTE format('CREATE TABLE %I.risk_assessment_invalidations (LIKE public.risk_assessment_invalidations INCLUDING ALL)',s);
  EXECUTE format('ALTER TABLE %I.risk_assessment_invalidations ADD FOREIGN KEY(consumer_name,tenant_id,event_id) REFERENCES %I.consumer_inbox(consumer_name,tenant_id,event_id)',s,s);
  EXECUTE format('ALTER TABLE %I.risk_assessment_invalidations ENABLE ROW LEVEL SECURITY',s);
  EXECUTE format('ALTER TABLE %I.risk_assessment_invalidations FORCE ROW LEVEL SECURITY',s);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I.risk_assessment_invalidations USING(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',s);
  EXECUTE format('REVOKE ALL ON %I.risk_assessment_invalidations FROM PUBLIC,projection_app,read_query',s);
  EXECUTE format('GRANT SELECT,INSERT ON %I.risk_assessment_invalidations TO projection_app',s);
  EXECUTE format('GRANT SELECT ON %I.risk_assessment_invalidations TO read_query',s);
 END LOOP;
 SELECT DISTINCT n.nspname INTO STRICT active_schema FROM pg_rewrite r
 JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid AND d.refclassid='pg_class'::regclass
 JOIN pg_class c ON c.oid=d.refobjid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE r.ev_class='read.risk_assessments'::regclass AND c.relname='risk_assessments' AND n.nspname<>'read';
 EXECUTE format('CREATE VIEW read.risk_assessment_invalidations WITH(security_invoker=true,security_barrier=true) AS SELECT * FROM %I.risk_assessment_invalidations',active_schema);
END $$;
REVOKE ALL ON read.risk_assessment_invalidations FROM PUBLIC;
GRANT SELECT ON read.risk_assessment_invalidations TO read_query;
