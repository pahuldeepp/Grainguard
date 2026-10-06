-- Greenfield tenant onboarding is durable even while every operational owner
-- remains unavailable. The creator identity is retained as pending first-admin
-- intent, but receives no membership until all owner proofs are verified.
CREATE TABLE tenant_bootstrap_jobs (
  tenant_id uuid PRIMARY KEY REFERENCES organizations(tenant_id) ON DELETE RESTRICT,
  job_id uuid NOT NULL UNIQUE,
  operation_id uuid NOT NULL UNIQUE,
  requested_admin_identity_id uuid NOT NULL REFERENCES identities(identity_id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  traceparent text NOT NULL CHECK (traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$'),
  shard_id text NOT NULL REFERENCES shard_registry(shard_id),
  shard_incarnation uuid NOT NULL,
  placement_epoch bigint NOT NULL CHECK (placement_epoch > 0),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','running','retry_wait','completed','blocked')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz,
  prepared_receipts jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(prepared_receipts) = 'array'),
  active_receipts jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(active_receipts) = 'array'),
  last_error_code text CHECK (last_error_code IN
    ('owner_unavailable','owner_contract_unavailable','lease_lost','retryable_failure')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK ((state = 'running') = (claim_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state = 'retry_wait') = (next_attempt_at IS NOT NULL))
);
CREATE INDEX tenant_bootstrap_jobs_claim
  ON tenant_bootstrap_jobs (COALESCE(next_attempt_at, created_at), created_at)
  WHERE state IN ('queued','running','retry_wait');

-- Preserve organizations created by earlier versions of the API before the
-- durable worker existed. The original creator is pending admin intent only;
-- membership is still withheld until the owner receipt gate completes.
INSERT INTO tenant_bootstrap_jobs (
  tenant_id, job_id, operation_id, requested_admin_identity_id,
  correlation_id, traceparent, shard_id, shard_incarnation, placement_epoch, state
)
SELECT o.tenant_id,
  md5('tenant-bootstrap-job:' || o.tenant_id::text)::uuid,
  md5('tenant-bootstrap-operation:' || o.tenant_id::text)::uuid,
  o.created_by,
  md5('tenant-bootstrap-operation:' || o.tenant_id::text)::uuid,
  '00-' || replace(gen_random_uuid()::text, '-', '') || '-' ||
    substr(replace(gen_random_uuid()::text, '-', ''), 1, 16) || '-01',
  o.shard_id, s.shard_incarnation, o.routing_epoch, 'queued'
FROM organizations o
JOIN shard_registry s ON s.shard_id = o.shard_id
WHERE o.state = 'provisioning'
  AND o.created_by IS NOT NULL
  AND s.shard_incarnation IS NOT NULL
  AND o.routing_epoch > 0
ON CONFLICT (tenant_id) DO NOTHING;

ALTER TABLE tenant_bootstrap_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_bootstrap_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_bootstrap_jobs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY bootstrap_worker_read ON tenant_bootstrap_jobs
  FOR SELECT TO control_migrator USING (true);
CREATE POLICY bootstrap_worker_update ON tenant_bootstrap_jobs
  FOR UPDATE TO control_migrator USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON tenant_bootstrap_jobs TO control_app;
GRANT UPDATE (state, attempts, claim_token, lease_until, next_attempt_at,
  prepared_receipts, active_receipts, last_error_code, updated_at, completed_at)
  ON tenant_bootstrap_jobs TO control_app;
GRANT SELECT, UPDATE ON tenant_bootstrap_jobs TO control_migrator;

-- Claim is one atomic SKIP LOCKED transition. A crashed worker's lease can be
-- reclaimed; claim_token fences its stale completion/retry updates.
CREATE FUNCTION claim_tenant_bootstrap_job()
RETURNS TABLE (
  tenant_id uuid, job_id uuid, operation_id uuid,
  requested_admin_identity_id uuid, correlation_id uuid, traceparent text,
  shard_id text,
  shard_incarnation uuid, placement_epoch bigint,
  attempts integer, claim_token uuid, lease_until timestamptz,
  prepared_receipts jsonb, active_receipts jsonb
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE tenant_bootstrap_jobs AS j
     SET state = 'blocked', claim_token = NULL, lease_until = NULL,
         next_attempt_at = NULL, last_error_code = 'retryable_failure',
         updated_at = clock_timestamp()
   WHERE j.attempts >= 8
     AND ((j.state = 'running' AND j.lease_until <= clock_timestamp())
       OR (j.state IN ('queued','retry_wait') AND
           (j.next_attempt_at IS NULL OR j.next_attempt_at <= clock_timestamp())));

  RETURN QUERY
  WITH candidate AS (
    SELECT j.tenant_id
      FROM tenant_bootstrap_jobs AS j
     WHERE j.attempts < 8
       AND (j.state = 'queued'
         OR (j.state = 'retry_wait' AND j.next_attempt_at <= clock_timestamp())
         OR (j.state = 'running' AND j.lease_until <= clock_timestamp()))
     ORDER BY COALESCE(j.next_attempt_at, j.created_at), j.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE tenant_bootstrap_jobs AS j
     SET state = 'running', attempts = j.attempts + 1,
         claim_token = gen_random_uuid(),
         lease_until = clock_timestamp() + interval '90 seconds',
         next_attempt_at = NULL, updated_at = clock_timestamp()
    FROM candidate AS c
   WHERE j.tenant_id = c.tenant_id
  RETURNING j.tenant_id, j.job_id, j.operation_id,
    j.requested_admin_identity_id, j.correlation_id, j.traceparent,
    j.shard_id, j.shard_incarnation,
    j.placement_epoch, j.attempts, j.claim_token, j.lease_until,
    j.prepared_receipts, j.active_receipts;
END
$$;
REVOKE ALL ON FUNCTION claim_tenant_bootstrap_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_tenant_bootstrap_job() TO control_app;

CREATE FUNCTION renew_tenant_bootstrap_job(
  p_tenant_id uuid, p_job_id uuid, p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE changed integer;
BEGIN
  UPDATE tenant_bootstrap_jobs
     SET lease_until = clock_timestamp() + interval '90 seconds',
         updated_at = clock_timestamp()
   WHERE tenant_id = p_tenant_id AND job_id = p_job_id
     AND claim_token = p_claim_token AND state = 'running'
     AND lease_until > clock_timestamp();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;
REVOKE ALL ON FUNCTION renew_tenant_bootstrap_job(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION renew_tenant_bootstrap_job(uuid,uuid,uuid) TO control_app;

CREATE FUNCTION retry_tenant_bootstrap_job(
  p_tenant_id uuid, p_job_id uuid, p_claim_token uuid, p_error_code text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE next_state text;
BEGIN
  IF p_error_code NOT IN
    ('owner_unavailable','owner_contract_unavailable','lease_lost','retryable_failure') THEN
    RAISE EXCEPTION 'invalid tenant bootstrap failure category';
  END IF;
  UPDATE tenant_bootstrap_jobs AS j
     SET state = CASE WHEN j.attempts >= 8 THEN 'blocked' ELSE 'retry_wait' END,
         claim_token = NULL, lease_until = NULL,
         next_attempt_at = CASE WHEN j.attempts >= 8 THEN NULL ELSE
           clock_timestamp() + make_interval(secs =>
             LEAST(900::numeric, power(2::numeric, LEAST(j.attempts, 9)))::double precision) END,
         last_error_code = p_error_code, updated_at = clock_timestamp()
   WHERE j.tenant_id = p_tenant_id AND j.job_id = p_job_id
     AND j.claim_token = p_claim_token AND j.state = 'running'
     AND j.lease_until > clock_timestamp()
  RETURNING j.state INTO next_state;
  IF next_state IS NULL THEN
    RAISE EXCEPTION 'tenant bootstrap claim lost';
  END IF;
  RETURN next_state;
END
$$;
REVOKE ALL ON FUNCTION retry_tenant_bootstrap_job(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retry_tenant_bootstrap_job(uuid,uuid,uuid,text) TO control_app;
