-- Stage 09e: a failing export must not crash-loop. Each failed attempt requeues the
-- job with exponential backoff (next_attempt_at); after the attempt cap enforced in
-- the application (5) it becomes 'failed' with a bounded, credential-free reason.
-- Concurrency: the worker claims with a conditional UPDATE (optimistic); the lease
-- is the only lock, so a crashed worker's job is reclaimed when the lease expires.
ALTER TABLE audit_export_jobs DROP CONSTRAINT audit_export_jobs_state_check;
ALTER TABLE audit_export_jobs ADD CONSTRAINT audit_export_jobs_state_check
 CHECK (state IN ('queued','running','ready','failed'));
ALTER TABLE audit_export_jobs
 ADD COLUMN next_attempt_at timestamptz,
 ADD COLUMN failed_at timestamptz,
 ADD COLUMN last_error text CHECK (char_length(last_error) <= 500);
GRANT UPDATE (next_attempt_at, failed_at, last_error) ON audit_export_jobs TO control_app;
DROP INDEX audit_export_jobs_pending;
CREATE INDEX audit_export_jobs_pending ON audit_export_jobs (created_at)
 WHERE state IN ('queued','running');
-- The selector still returns opaque identities only. Queued jobs wait for their
-- backoff; running jobs are reclaimable once their lease expires (the application
-- fails those that already used every attempt).
CREATE OR REPLACE FUNCTION claim_audit_export_job() RETURNS TABLE (tenant_id uuid, job_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT j.tenant_id, j.job_id FROM audit_export_jobs j
   WHERE (j.state = 'queued' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= now()))
      OR (j.state = 'running' AND j.lease_until < now())
   ORDER BY j.created_at LIMIT 1
 $$;
