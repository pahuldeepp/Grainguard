-- Audit export requests are serialized by their row lock. A worker may reclaim a
-- lease after a crash; the immutable object directory is keyed by job_id.
CREATE TABLE audit_export_jobs (
 tenant_id uuid NOT NULL,
 job_id uuid NOT NULL,
 requester_id uuid NOT NULL,
 from_at timestamptz NOT NULL,
 to_at timestamptz NOT NULL,
 format text NOT NULL CHECK (format = 'jsonl'),
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','ready')),
 lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 file_sha256 text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '7 days'),
 PRIMARY KEY (tenant_id, job_id),
 CHECK (from_at < to_at)
);
CREATE INDEX audit_export_jobs_pending ON audit_export_jobs (created_at)
 WHERE state <> 'ready';
CREATE TABLE audit_export_actions (
 tenant_id uuid NOT NULL,
 audit_id uuid NOT NULL,
 job_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK (action IN ('requested','downloaded')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (tenant_id, audit_id)
);
CREATE INDEX audit_export_actions_page ON audit_export_actions
 (tenant_id, occurred_at, audit_id);
CREATE INDEX membership_events_export_page ON membership_events
 (tenant_id, occurred_at, audit_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['audit_export_jobs','audit_export_actions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
 END LOOP;
END $$;
-- SECURITY DEFINER selector runs as the migration owner. FORCE RLS still
-- applies to that owner, so only its SELECT policy can see pending identities.
CREATE POLICY worker_select ON audit_export_jobs FOR SELECT TO control_migrator
 USING (true);
GRANT SELECT, INSERT, UPDATE (state, lease_until, attempts, file_sha256, completed_at)
 ON audit_export_jobs TO control_app;
GRANT SELECT, INSERT ON audit_export_actions TO control_app;
-- Only opaque job identities escape the privileged selector; every data access
-- afterwards is made under the tenant transaction and its RLS policy.
CREATE FUNCTION claim_audit_export_job() RETURNS TABLE (tenant_id uuid, job_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT j.tenant_id, j.job_id FROM audit_export_jobs j
   WHERE j.state = 'queued' OR (j.state = 'running' AND j.lease_until < now())
   ORDER BY j.created_at LIMIT 1
 $$;
REVOKE ALL ON FUNCTION claim_audit_export_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_audit_export_job() TO control_app;
