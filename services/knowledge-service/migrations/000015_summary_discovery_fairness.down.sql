CREATE OR REPLACE FUNCTION knowledge_summary_pending_principals(scope uuid)
 RETURNS TABLE(user_id uuid) LANGUAGE sql SECURITY DEFINER
 SET search_path=pg_catalog AS $$
 SELECT DISTINCT j.user_id FROM public.assistant_summary_jobs j
 WHERE j.tenant_id=scope
 AND scope=NULLIF(current_setting('app.tenant_id',true),'')::uuid
 AND (j.expires_at<=clock_timestamp() OR j.status='queued'
   OR (j.status='running' AND j.lease_expires_at<clock_timestamp()))
 ORDER BY j.user_id LIMIT 100
 $$;
