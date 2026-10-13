\set ON_ERROR_STOP on
\getenv knowledge_app_password KNOWLEDGE_APP_PASSWORD
\getenv knowledge_migrator_password KNOWLEDGE_MIGRATOR_PASSWORD
\getenv knowledge_provisioner_password KNOWLEDGE_PROVISIONER_PASSWORD
\getenv knowledge_reviewer_password KNOWLEDGE_REVIEWER_PASSWORD
\getenv knowledge_worker_password KNOWLEDGE_WORKER_PASSWORD
\getenv advisor_app_password ADVISOR_APP_PASSWORD
\getenv advisor_migrator_password ADVISOR_MIGRATOR_PASSWORD
\getenv advisor_checkpoint_app_password ADVISOR_CHECKPOINT_APP_PASSWORD
\getenv advisor_checkpoint_migrator_password ADVISOR_CHECKPOINT_MIGRATOR_PASSWORD
\getenv gateway_app_password MODEL_GATEWAY_APP_PASSWORD
\getenv gateway_usage_password MODEL_GATEWAY_USAGE_PASSWORD
\getenv gateway_migrator_password MODEL_GATEWAY_MIGRATOR_PASSWORD

-- Bootstrap never adopts an unmarked role/database with a matching name.
-- Runtime roles are intentionally LOGIN, non-superuser, non-owner, and NOBYPASSRLS.
DO $$
DECLARE role_name text; r record; d record; expected_owner text; marker constant text := 'greenguard.ai.database-bootstrap.v1';
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'knowledge_app','knowledge_worker','knowledge_migrator','knowledge_provisioner','knowledge_reviewer',
    'advisor_app','advisor_migrator','advisor_checkpoint_app','advisor_checkpoint_migrator',
    'model_gateway_app','model_gateway_usage_app','model_gateway_migrator'
  ] LOOP
    SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls,rolreplication,
           shobj_description(oid,'pg_authid') AS comment INTO r FROM pg_roles WHERE rolname=role_name;
    IF FOUND AND (r.comment IS DISTINCT FROM marker OR NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb
      OR r.rolcreaterole OR r.rolinherit OR r.rolbypassrls OR r.rolreplication
      OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member
                 WHERE m.member=r.oid OR (m.roleid=r.oid AND member.rolname <> 'greenguard_admin'))) THEN
      RAISE EXCEPTION 'refusing to adopt or alter foreign/elevated AI role %',role_name;
    END IF;
  END LOOP;
  FOR d IN SELECT db.datname,owner.rolname AS owner,shobj_description(db.oid,'pg_database') AS comment
      FROM pg_database db JOIN pg_roles owner ON owner.oid=db.datdba
      WHERE db.datname IN ('greenguard_knowledge','greenguard_advisor','greenguard_advisor_checkpoint','greenguard_ai_usage')
  LOOP
    expected_owner := CASE d.datname
      WHEN 'greenguard_knowledge' THEN 'greenguard_admin'
      WHEN 'greenguard_advisor' THEN 'greenguard_admin'
      WHEN 'greenguard_advisor_checkpoint' THEN 'greenguard_admin'
      ELSE 'greenguard_admin'
    END;
    IF d.comment IS DISTINCT FROM marker OR d.owner <> expected_owner THEN
      RAISE EXCEPTION 'refusing to adopt or take ownership of foreign AI database %',d.datname;
    END IF;
  END LOOP;
END $$;

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',r)
  FROM (VALUES ('knowledge_app'),('knowledge_worker'),('knowledge_migrator'),('knowledge_provisioner'),('knowledge_reviewer'),
    ('advisor_app'),('advisor_migrator'),('advisor_checkpoint_app'),('advisor_checkpoint_migrator'),
    ('model_gateway_app'),('model_gateway_usage_app'),('model_gateway_migrator')) AS roles(r)
  WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) \gexec
ALTER ROLE knowledge_app PASSWORD :'knowledge_app_password';
ALTER ROLE knowledge_worker PASSWORD :'knowledge_worker_password';
ALTER ROLE knowledge_migrator PASSWORD :'knowledge_migrator_password';
ALTER ROLE knowledge_provisioner PASSWORD :'knowledge_provisioner_password';
ALTER ROLE knowledge_reviewer PASSWORD :'knowledge_reviewer_password';
ALTER ROLE advisor_app PASSWORD :'advisor_app_password';
ALTER ROLE advisor_migrator PASSWORD :'advisor_migrator_password';
ALTER ROLE advisor_checkpoint_app PASSWORD :'advisor_checkpoint_app_password';
ALTER ROLE advisor_checkpoint_migrator PASSWORD :'advisor_checkpoint_migrator_password';
ALTER ROLE model_gateway_app PASSWORD :'gateway_app_password';
ALTER ROLE model_gateway_usage_app PASSWORD :'gateway_usage_password';
ALTER ROLE model_gateway_migrator PASSWORD :'gateway_migrator_password';
SELECT format('COMMENT ON ROLE %I IS %L',rolname,'greenguard.ai.database-bootstrap.v1')
  FROM pg_roles WHERE rolname IN ('knowledge_app','knowledge_worker','knowledge_migrator','knowledge_provisioner','knowledge_reviewer',
    'advisor_app','advisor_migrator','advisor_checkpoint_app','advisor_checkpoint_migrator',
    'model_gateway_app','model_gateway_usage_app','model_gateway_migrator')
    AND shobj_description(oid,'pg_authid') IS NULL \gexec

SELECT 'CREATE DATABASE greenguard_knowledge OWNER greenguard_admin' WHERE NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='greenguard_knowledge') \gexec
SELECT 'CREATE DATABASE greenguard_advisor OWNER greenguard_admin' WHERE NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='greenguard_advisor') \gexec
SELECT 'CREATE DATABASE greenguard_advisor_checkpoint OWNER greenguard_admin' WHERE NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='greenguard_advisor_checkpoint') \gexec
SELECT 'CREATE DATABASE greenguard_ai_usage OWNER greenguard_admin' WHERE NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='greenguard_ai_usage') \gexec
SELECT format('COMMENT ON DATABASE %I IS %L',datname,'greenguard.ai.database-bootstrap.v1')
  FROM pg_database WHERE datname IN ('greenguard_knowledge','greenguard_advisor','greenguard_advisor_checkpoint','greenguard_ai_usage')
    AND shobj_description(oid,'pg_database') IS NULL \gexec
REVOKE ALL ON DATABASE greenguard_knowledge,greenguard_advisor,greenguard_advisor_checkpoint,greenguard_ai_usage FROM PUBLIC;
GRANT CONNECT ON DATABASE greenguard_knowledge TO knowledge_app,knowledge_worker,knowledge_migrator,knowledge_provisioner,knowledge_reviewer;
GRANT CONNECT ON DATABASE greenguard_advisor TO advisor_app,advisor_migrator;
GRANT CONNECT ON DATABASE greenguard_advisor_checkpoint TO advisor_checkpoint_app,advisor_checkpoint_migrator;
GRANT CONNECT ON DATABASE greenguard_ai_usage TO model_gateway_app,model_gateway_usage_app,model_gateway_migrator;
\connect greenguard_knowledge
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO knowledge_app,knowledge_worker,knowledge_provisioner,knowledge_reviewer;
GRANT USAGE,CREATE ON SCHEMA public TO knowledge_migrator;
\connect greenguard_advisor
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO advisor_app;
GRANT USAGE,CREATE ON SCHEMA public TO advisor_migrator;
\connect greenguard_advisor_checkpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO advisor_checkpoint_app;
GRANT USAGE,CREATE ON SCHEMA public TO advisor_checkpoint_migrator;
\connect greenguard_ai_usage
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO model_gateway_app,model_gateway_usage_app;
GRANT USAGE,CREATE ON SCHEMA public TO model_gateway_migrator;
