-- Oldest waiting principal first, so repeated jobs for low UUIDs cannot starve
-- another principal when the bounded discovery page is full.
CREATE OR REPLACE FUNCTION knowledge_summary_pending_principals(scope uuid)
 RETURNS TABLE(user_id uuid) LANGUAGE sql SECURITY DEFINER
 SET search_path=pg_catalog AS $$
 SELECT j.user_id FROM public.assistant_summary_jobs j
 WHERE j.tenant_id=scope
 AND scope=NULLIF(current_setting('app.tenant_id',true),'')::uuid
 AND (j.expires_at<=clock_timestamp() OR j.status='queued'
   OR (j.status='running' AND j.lease_expires_at<clock_timestamp()))
 GROUP BY j.user_id ORDER BY min(j.created_at),j.user_id LIMIT 100
 $$;
