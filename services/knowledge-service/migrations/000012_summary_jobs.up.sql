-- PostgreSQL is the durable queue; no non-atomic DB/queue dual write.
-- SKIP LOCKED claim + expiring lease token fences concurrent/stale workers.
CREATE TABLE assistant_summary_jobs (
 tenant_id uuid NOT NULL, user_id uuid NOT NULL, job_id uuid NOT NULL,
 idempotency_key uuid NOT NULL, document_id uuid NOT NULL,
 document_version bigint NOT NULL CHECK(document_version BETWEEN 1 AND 2147483647),
 question text NOT NULL CHECK(length(question) BETWEEN 4 AND 2000),
 authorized_role text NOT NULL CHECK(authorized_role IN ('viewer','operator','admin')),
 answer_model text NOT NULL CHECK(length(answer_model) BETWEEN 1 AND 128),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
 completed_batches integer NOT NULL DEFAULT 0 CHECK(completed_batches BETWEEN 0 AND 250),
 total_batches integer NOT NULL DEFAULT 0 CHECK(total_batches BETWEEN 0 AND 250),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 lease_token uuid, lease_expires_at timestamptz,
 parts jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(parts)='object'),
 result jsonb CHECK(result IS NULL OR jsonb_typeof(result)='object'),
 error_code text CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '7 days',
 PRIMARY KEY(tenant_id,user_id,job_id), UNIQUE(tenant_id,user_id,idempotency_key),
 FOREIGN KEY(tenant_id,document_id,document_version)
  REFERENCES knowledge_document_versions(tenant_id,document_id,document_version) ON DELETE CASCADE,
 CHECK(completed_batches<=total_batches)
);
CREATE INDEX assistant_summary_jobs_pending ON assistant_summary_jobs(tenant_id,user_id,created_at)
 WHERE status IN ('queued','running');
ALTER TABLE assistant_summary_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_summary_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY principal_isolation ON assistant_summary_jobs
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
 AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
 AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
REVOKE ALL ON assistant_summary_jobs FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='knowledge_app') THEN
 GRANT SELECT,INSERT,UPDATE,DELETE ON assistant_summary_jobs TO knowledge_app;
 END IF;
END $$;
