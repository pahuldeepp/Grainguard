-- Narrow discovery only: returns at most 100 principal UUIDs with runnable or
-- expired jobs for the trusted tenant setting, never payloads/results. Worker
-- operations themselves still run under forced tenant + principal RLS.
CREATE FUNCTION knowledge_summary_pending_principals(scope uuid)
 RETURNS TABLE(user_id uuid) LANGUAGE sql SECURITY DEFINER
 SET search_path=pg_catalog AS $$
 SELECT DISTINCT j.user_id FROM public.assistant_summary_jobs j
 WHERE j.tenant_id=scope
 AND scope=NULLIF(current_setting('app.tenant_id',true),'')::uuid
 AND (j.expires_at<=clock_timestamp() OR j.status='queued'
   OR (j.status='running' AND j.lease_expires_at<clock_timestamp()))
 ORDER BY j.user_id LIMIT 100
 $$;
REVOKE ALL ON FUNCTION knowledge_summary_pending_principals(uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='knowledge_app') THEN
 GRANT EXECUTE ON FUNCTION knowledge_summary_pending_principals(uuid) TO knowledge_app;
 END IF;
END $$;
