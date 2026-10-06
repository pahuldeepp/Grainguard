DROP FUNCTION IF EXISTS projection_history_cassandra_repair_events(text);
ALTER POLICY tenant_isolation ON public.consumer_inbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
